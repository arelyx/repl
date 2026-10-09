"""Thin wrapper around the git CLI. All functions are blocking; call via run_in_threadpool.

git never runs in the backend. Repl users have a shell next to their .git
directory, so .git/config and .gitattributes are attacker-controlled
(core.fsmonitor, hooks and filter drivers can all run commands), and the
backend holds the Docker socket and sits on every repl's network. Every git
command therefore runs inside the repl's own sandbox:

  * the repl's container, via `docker exec` as uid 1000, when it is running;
  * otherwise a throwaway container from the runner image with no network,
    uid 1000, small memory/pid/CPU caps, a read-only root and only the repl
    directory mounted. It lives for one API call.

Inside, git still gets a throwaway HOME, no system or global config, and the
common command-running knobs forced off, so the API never runs the user's
hooks or helpers on their behalf.
"""
import re
import secrets
import time

from fastapi import HTTPException

from app.config import settings
from app.services.fsops import chown_tree

APP_DIR = "/home/runner/app"
RUNNER_USER = "1000:1000"
GIT_TIMEOUT = 60

_GIT_ENV = {
    "PATH": "/usr/local/bin:/usr/bin:/bin",
    "HOME": "/tmp/replot-git-home",
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_TERMINAL_PROMPT": "0",
    "LANG": "C.UTF-8",
}
_GIT_HARDENING = [
    "-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.sshCommand=false",
    "-c", "core.editor=false",
    "-c", "core.pager=cat",
    "-c", "credential.helper=",
    "-c", "protocol.allow=never",
    "-c", "diff.external=",
]
_REPL_ID = re.compile(r"^[a-z0-9]+$")


class GitError(Exception):
    pass


def _docker():
    from app.services import runtime

    return runtime.docker_client()


class _Sandbox:
    """Where one API call's git commands run: the repl's running container,
    or a throwaway one started for the call and removed afterwards."""

    def __init__(self, repo: str):
        self.repl_id = repo.rstrip("/").rsplit("/", 1)[-1]
        if not _REPL_ID.match(self.repl_id):
            raise GitError("invalid repository")
        self.container_id = None
        self.throwaway = False

    def __enter__(self):
        from app.services import runtime

        c = runtime._get(self.repl_id)
        if c is not None and c.status == "running":
            self.container_id = c.id
        else:
            self._start_throwaway()
        return self

    def __exit__(self, *exc):
        self._drop_throwaway()

    def _start_throwaway(self):
        from docker.types import LogConfig

        kwargs = dict(
            image=settings.RUNNER_IMAGE,
            name=f"repl-git-{self.repl_id}-{secrets.token_hex(4)}",
            # Self-destructs even if the backend dies before removing it.
            entrypoint=["/usr/bin/tini", "--", "sleep", "300"],
            command=[],
            detach=True,
            auto_remove=True,
            user=RUNNER_USER,
            working_dir=APP_DIR,
            network_mode="none",
            read_only=True,
            tmpfs={"/tmp": "rw,nosuid,nodev,size=64m,mode=1777"},
            volumes={f"{settings.repls_host_dir}/{self.repl_id}": {"bind": APP_DIR, "mode": "rw"}},
            mem_limit=settings.GIT_CONTAINER_MEMORY,
            memswap_limit=settings.GIT_CONTAINER_MEMORY,
            pids_limit=settings.GIT_CONTAINER_PIDS,
            nano_cpus=int(settings.GIT_CONTAINER_CPUS * 1e9),
            cap_drop=["ALL"],
            security_opt=["no-new-privileges"],
            oom_score_adj=800,
            log_config=LogConfig(type="json-file", config={"max-size": "1m", "max-file": "1"}),
            labels={"replot.git": self.repl_id},
            environment={"REPL_ID": self.repl_id},
        )
        if settings.REPL_RUNTIME:
            kwargs["runtime"] = settings.REPL_RUNTIME
        if settings.REPL_CGROUP_PARENT:
            kwargs["cgroup_parent"] = settings.REPL_CGROUP_PARENT
        from app.services import runtime

        c = runtime.run_container(kwargs)
        self.container_id = c.id
        self.throwaway = True

    def _drop_throwaway(self):
        if not (self.throwaway and self.container_id):
            return
        import docker.errors

        try:
            _docker().api.remove_container(self.container_id, force=True)
        except docker.errors.APIError:
            pass  # auto_remove got there first
        self.container_id = None
        self.throwaway = False

    def exec(self, argv: list[str], env: dict[str, str] | None = None) -> tuple[int, str, str]:
        import docker.errors

        api = _docker().api
        cmd = ["timeout", "-k", "5", str(GIT_TIMEOUT), *argv]
        for attempt in range(2):
            try:
                ex = api.exec_create(self.container_id, cmd, user=RUNNER_USER, workdir=APP_DIR,
                                     environment={**_GIT_ENV, **(env or {})})
                out, err = api.exec_start(ex["Id"], demux=True)
                code = api.exec_inspect(ex["Id"]).get("ExitCode")
                break
            except docker.errors.APIError as e:
                # The repl was stopped under us: finish in a throwaway container.
                if attempt or self.throwaway or e.status_code not in (404, 409):
                    raise
                self._start_throwaway()
        out = (out or b"").decode("utf-8", "replace")
        err = (err or b"").decode("utf-8", "replace")
        if code == 124:
            err = (err + "\ngit timed out").strip()
        return code if code is not None else -1, out, err

    def git(
        self, *args: str, author: tuple[str, str] | None = None, check: bool = True,
        env_extra: dict[str, str] | None = None,
    ) -> str:
        cmd = ["git", "-c", "safe.directory=*", "-c", "core.quotepath=false", *_GIT_HARDENING]
        if author:
            cmd += ["-c", f"user.name={author[0]}", "-c", f"user.email={author[1]}"]
        else:
            cmd += ["-c", "user.name=Replot", "-c", "user.email=replot@localhost"]
        cmd += list(args)
        code, out, err = self.exec(cmd, env_extra)
        if check and code != 0:
            raise GitError((err or out).strip())
        return out


def git(repo: str, *args: str, **kw) -> str:
    """One git command in its own sandbox (prefer _Sandbox for several)."""
    with _Sandbox(repo) as g:
        return g.git(*args, **kw)


def init_repo(repo: str, message: str, author: tuple[str, str]) -> None:
    chown_tree(repo)  # the template was copied by the backend; git runs as the repl uid
    with _Sandbox(repo) as g:
        g.git("init", "-b", "main")
        g.git("add", "-A")
        _commit(g, message, author, allow_empty=True)


def _commit(g: _Sandbox, message: str, author: tuple[str, str], allow_empty: bool = False) -> str:
    g.git("add", "-A")
    if not allow_empty and not g.git("status", "--porcelain").strip():
        raise HTTPException(status_code=400, detail="Nothing to commit")
    args = ["commit", "-m", message, f"--author={author[0]} <{author[1]}>"]
    if allow_empty:
        args.append("--allow-empty")
    g.git(*args, author=author)
    return g.git("rev-parse", "HEAD").strip()


def commit(repo: str, message: str, author: tuple[str, str], allow_empty: bool = False) -> str:
    with _Sandbox(repo) as g:
        return _commit(g, message, author, allow_empty)


def status(repo: str) -> dict:
    with _Sandbox(repo) as g:
        branch = g.git("rev-parse", "--abbrev-ref", "HEAD", check=False).strip() or "main"
        out = g.git("status", "--porcelain=v1", "-uall")
    changes = []
    for line in out.splitlines():
        if len(line) < 4:
            continue
        code = line[:2]
        path = line[3:]
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        path = path.strip('"')
        if code == "??":
            st = "untracked"
        elif "D" in code:
            st = "deleted"
        elif "A" in code:
            st = "added"
        elif "R" in code:
            st = "renamed"
        else:
            st = "modified"
        changes.append({"path": path, "status": st})
    return {"branch": branch, "changes": changes}


SEP = "\x1f"


def log(repo: str, limit: int = 50) -> list[dict]:
    fmt = SEP.join(["%H", "%h", "%s", "%an", "%ae", "%aI"]) + "\x1e"
    out = git(repo, "log", f"-n{limit}", f"--format={fmt}", check=False)
    entries = []
    for rec in out.split("\x1e"):
        rec = rec.strip("\n")
        if not rec:
            continue
        parts = rec.split(SEP)
        if len(parts) != 6:
            continue
        entries.append(
            {
                "sha": parts[0],
                "short_sha": parts[1],
                "message": parts[2],
                "author_name": parts[3],
                "author_email": parts[4],
                "date": parts[5],
            }
        )
    return entries


def validate_sha(sha: str) -> str:
    sha = sha.strip()
    if not sha or not all(c in "0123456789abcdefABCDEF" for c in sha) or len(sha) > 64:
        raise HTTPException(status_code=400, detail="Invalid sha")
    return sha


def diff(repo: str, sha: str | None) -> str:
    if sha:
        sha = validate_sha(sha)
        return git(repo, "show", "--no-ext-diff", "--format=", "--patch", sha)
    # Working tree (including untracked) vs HEAD. Viewers can call this, so
    # never touch the real index: build a throwaway one from HEAD, mark
    # untracked files intent-to-add in it, and diff against that.
    with _Sandbox(repo) as g:
        index = f"/tmp/replot-diff-{secrets.token_hex(8)}.index"
        env = {"GIT_INDEX_FILE": index}
        try:
            g.git("read-tree", "HEAD", check=False, env_extra=env)
            g.git("add", "-A", "--intent-to-add", check=False, env_extra=env)
            return g.git("diff", "--no-ext-diff", "HEAD", env_extra=env)
        finally:
            if not g.throwaway:
                g.exec(["rm", "-f", index, index + ".lock"])


def show(repo: str, sha: str, path: str) -> str:
    sha = validate_sha(sha)
    try:
        return git(repo, "show", f"{sha}:{path}")
    except GitError as e:
        raise HTTPException(status_code=404, detail=str(e))


def restore(repo: str, sha: str, path: str | None, author: tuple[str, str]) -> str:
    sha = validate_sha(sha)
    with _Sandbox(repo) as g:
        short = g.git("rev-parse", "--short", sha).strip()
        if path:
            g.git("checkout", sha, "--", path)
        else:
            # Remove files committed after sha (so the tree matches), then check out sha's tree.
            added = g.git("diff", "--name-only", "--diff-filter=A", "-z", sha, "HEAD", check=False)
            paths = [p for p in added.split("\0") if p]
            for i in range(0, len(paths), 500):
                g.git("rm", "-q", "-f", "--ignore-unmatch", "--", *paths[i:i + 500], check=False)
            g.git("checkout", sha, "--", ".")
        try:
            return _commit(g, f"Restore to {short}", author)
        except HTTPException:
            return g.git("rev-parse", "HEAD").strip()


def remove_stale_sandboxes(max_age_seconds: int = 600) -> None:
    """Throwaway git containers normally die with their API call (and exit on
    their own after 5 minutes); sweep any the backend lost track of."""
    import docker.errors

    api = _docker().api
    now = time.time()
    for c in api.containers(all=True, filters={"label": "replot.git"}):
        if now - int(c.get("Created", now)) > max_age_seconds:
            try:
                api.remove_container(c["Id"], force=True)
            except docker.errors.APIError:
                pass

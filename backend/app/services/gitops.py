"""Thin wrapper around the git CLI. All functions are blocking; call via run_in_threadpool."""
import os
import shutil
import subprocess
import tempfile

from fastapi import HTTPException

from app.services.fsops import RUNNER_GID, RUNNER_UID, chown_tree

# Repl users have a shell next to their .git directory, so .git/config and
# .gitattributes are attacker-controlled (core.fsmonitor, hooks, filter
# drivers can all run commands). The backend holds the Docker socket, so git
# must never run as root: it runs as the repl's own unprivileged uid, with no
# supplementary groups (no docker group), a throwaway HOME, no system/global
# config, and the common command-running knobs forced off.
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


class GitError(Exception):
    pass


def git(
    repo: str, *args: str, author: tuple[str, str] | None = None, check: bool = True,
    env_extra: dict[str, str] | None = None,
) -> str:
    cmd = ["git", "-c", "safe.directory=*", "-c", "core.quotepath=false", *_GIT_HARDENING]
    if author:
        cmd += ["-c", f"user.name={author[0]}", "-c", f"user.email={author[1]}"]
    else:
        cmd += ["-c", "user.name=Replot", "-c", "user.email=replot@localhost"]
    cmd += list(args)
    p = subprocess.run(
        cmd, cwd=repo, capture_output=True, text=True, errors="replace", timeout=60,
        env={**_GIT_ENV, **(env_extra or {})}, user=RUNNER_UID, group=RUNNER_GID, extra_groups=[],
    )
    if check and p.returncode != 0:
        raise GitError((p.stderr or p.stdout).strip())
    return p.stdout


def init_repo(repo: str, message: str, author: tuple[str, str]) -> None:
    chown_tree(repo)  # git runs as the repl uid, so it must own the tree first
    git(repo, "init", "-b", "main")
    git(repo, "add", "-A")
    commit(repo, message, author, allow_empty=True)
    chown_tree(repo)


def commit(repo: str, message: str, author: tuple[str, str], allow_empty: bool = False) -> str:
    git(repo, "add", "-A")
    if not allow_empty and not git(repo, "status", "--porcelain").strip():
        raise HTTPException(status_code=400, detail="Nothing to commit")
    args = ["commit", "-m", message, f"--author={author[0]} <{author[1]}>"]
    if allow_empty:
        args.append("--allow-empty")
    git(repo, *args, author=author)
    chown_tree(repo + "/.git")
    return git(repo, "rev-parse", "HEAD").strip()


def status(repo: str) -> dict:
    branch = git(repo, "rev-parse", "--abbrev-ref", "HEAD", check=False).strip() or "main"
    out = git(repo, "status", "--porcelain=v1", "-uall")
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
    tmpdir = tempfile.mkdtemp(prefix="replot-diff-")
    try:
        os.chown(tmpdir, RUNNER_UID, RUNNER_GID)
        env = {"GIT_INDEX_FILE": os.path.join(tmpdir, "index")}
        git(repo, "read-tree", "HEAD", check=False, env_extra=env)
        git(repo, "add", "-A", "--intent-to-add", check=False, env_extra=env)
        return git(repo, "diff", "--no-ext-diff", "HEAD", env_extra=env)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def show(repo: str, sha: str, path: str) -> str:
    sha = validate_sha(sha)
    try:
        return git(repo, "show", f"{sha}:{path}")
    except GitError as e:
        raise HTTPException(status_code=404, detail=str(e))


def restore(repo: str, sha: str, path: str | None, author: tuple[str, str]) -> str:
    sha = validate_sha(sha)
    short = git(repo, "rev-parse", "--short", sha).strip()
    if path:
        git(repo, "checkout", sha, "--", path)
    else:
        # Remove files committed after sha (so the tree matches), then check out sha's tree.
        added = git(repo, "diff", "--name-only", "--diff-filter=A", "-z", sha, "HEAD", check=False)
        for rel in filter(None, added.split("\0")):
            git(repo, "rm", "-q", "-f", "--", rel, check=False)
        git(repo, "checkout", sha, "--", ".")
    chown_tree(repo)
    try:
        return commit(repo, f"Restore to {short}", author)
    except HTTPException:
        return git(repo, "rev-parse", "HEAD").strip()

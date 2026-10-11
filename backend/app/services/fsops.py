"""Filesystem helpers for repl working trees. Blocking; call via run_in_threadpool."""
import base64
import errno
import os
import shutil
import stat
import tempfile
import time
import tomllib
import zipfile
from contextlib import contextmanager
from pathlib import Path

from fastapi import HTTPException

from app.config import settings

RUNNER_UID = 1000
RUNNER_GID = 1000
SKIP_DESCEND = {
    "node_modules", "__pycache__", "target", ".venv", "venv", "bin", "obj", ".gradle", "build",
    ".mypy_cache", ".pytest_cache", "dist", ".next",
}
MAX_LIST = 5000


def repl_root(repl_id: str) -> Path:
    return Path(settings.REPLS_DIR) / repl_id


def chown_tree(path: str | Path) -> None:
    # The repl user can swap any directory under `path` for a symlink while we
    # walk, so never resolve a joined path: chown each entry relative to its
    # parent's fd without following symlinks (fwalk never descends symlinks).
    path = str(path)
    try:
        os.lchown(path, RUNNER_UID, RUNNER_GID)
        for _dirpath, dirnames, filenames, dirfd in os.fwalk(path, follow_symlinks=False):
            for n in dirnames + filenames:
                try:
                    os.chown(n, RUNNER_UID, RUNNER_GID, dir_fd=dirfd, follow_symlinks=False)
                except OSError:
                    pass
    except (PermissionError, FileNotFoundError):
        pass  # not root (local dev) -- ignore


def chown_one(path: str | Path) -> None:
    try:
        os.lchown(str(path), RUNNER_UID, RUNNER_GID)
    except (PermissionError, FileNotFoundError):
        pass


def safe_path(repl_id: str, rel: str, allow_root: bool = False) -> Path:
    root = repl_root(repl_id).resolve()
    rel = (rel or "").replace("\\", "/").strip()
    while rel.startswith("./"):
        rel = rel[2:]
    rel = rel.strip("/")
    if not rel:
        if allow_root:
            return root
        raise HTTPException(status_code=400, detail="Path required")
    if "\0" in rel:
        raise HTTPException(status_code=400, detail="Invalid path")
    parts = rel.split("/")
    if any(p in ("", ".", "..") for p in parts) or parts[0] == ".git":
        raise HTTPException(status_code=400, detail="Invalid path")
    if ".git" in parts:
        raise HTTPException(status_code=400, detail="Invalid path")
    candidate = root / rel
    # Resolve only the parent: the target itself may be a symlink the user
    # wants to delete or rename. Opening through it is refused later by
    # O_NOFOLLOW in _parent_beneath / _open_beneath.
    parent = candidate.parent.resolve()
    if parent != root and root not in parent.parents:
        raise HTTPException(status_code=400, detail="Path escapes repl")
    return candidate


def list_files(repl_id: str) -> list[dict]:
    root = repl_root(repl_id)
    out: list[dict] = []
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root)
        rel_dir = "" if rel_dir == "." else rel_dir
        keep = []
        for d in sorted(dirnames):
            # .repl holds installed packages and caches (runner/agent/packager.py).
            if d == ".git" or (d == ".repl" and not rel_dir):
                continue
            full = os.path.join(dirpath, d)
            relp = f"{rel_dir}/{d}" if rel_dir else d
            out.append({"path": relp, "type": "dir", "size": 0})
            if d in SKIP_DESCEND or os.path.islink(full):
                continue
            keep.append(d)
        dirnames[:] = keep
        for f in filenames:
            full = os.path.join(dirpath, f)
            relp = f"{rel_dir}/{f}" if rel_dir else f
            try:
                size = os.lstat(full).st_size
            except OSError:
                size = 0
            out.append({"path": relp, "type": "file", "size": size})
        if len(out) > MAX_LIST:
            break
    out.sort(key=lambda n: n["path"])
    return out


@contextmanager
def _parent_beneath(repl_id: str, rel: str, create_parents: bool = False):
    """Yield (dir_fd, name) for `rel`'s parent directory under the repl root,
    reached without following any symlink.

    safe_path() checks the resolved path, but the repl user can swap a path
    component for a symlink between that check and our (root) syscall, e.g.
    to read /proc/self/environ. Walking component by component with
    O_NOFOLLOW relative to the parent's fd closes that race; callers then use
    *at() syscalls on (dir_fd, name).
    """
    safe_path(repl_id, rel)
    parts = [p for p in rel.replace("\\", "/").strip().strip("/").split("/") if p not in ("", ".")]
    dir_fd = os.open(repl_root(repl_id), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        try:
            for name in parts[:-1]:
                try:
                    nxt = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dir_fd)
                except FileNotFoundError:
                    if not create_parents:
                        raise
                    os.mkdir(name, 0o755, dir_fd=dir_fd)
                    os.chown(name, RUNNER_UID, RUNNER_GID, dir_fd=dir_fd, follow_symlinks=False)
                    nxt = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dir_fd)
                os.close(dir_fd)
                dir_fd = nxt
        except (FileNotFoundError, NotADirectoryError):
            raise HTTPException(status_code=404, detail="Not found")
        except OSError as e:
            if e.errno == errno.ELOOP:
                raise HTTPException(status_code=400, detail="Refusing to follow a symlink")
            raise
        yield dir_fd, parts[-1]
    finally:
        os.close(dir_fd)


def _open_beneath(repl_id: str, rel: str, flags: int, create_parents: bool = False) -> int:
    with _parent_beneath(repl_id, rel, create_parents) as (dir_fd, name):
        try:
            # O_NONBLOCK so a FIFO planted by the repl user can't hang the open.
            fd = os.open(name, flags | os.O_NOFOLLOW | os.O_NONBLOCK, 0o644, dir_fd=dir_fd)
        except (FileNotFoundError, NotADirectoryError):
            raise HTTPException(status_code=404, detail="File not found")
        except OSError as e:
            if e.errno == errno.ELOOP:
                raise HTTPException(status_code=400, detail="Refusing to follow a symlink")
            if e.errno == errno.EISDIR:
                raise HTTPException(status_code=400, detail="Path is a directory")
            if e.errno == errno.ENXIO:  # write-open of a FIFO with no reader
                raise HTTPException(status_code=400, detail="Not a regular file")
            raise
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise HTTPException(status_code=400, detail="Not a regular file")
    os.set_blocking(fd, True)
    return fd


def _too_large(what: str, limit: int) -> HTTPException:
    return HTTPException(status_code=413, detail=f"{what} exceeds the {limit // (1024 * 1024)} MB limit")


def _read_bytes(repl_id: str, rel: str) -> bytes:
    limit = settings.MAX_FILE_READ_MB * 1024 * 1024
    fd = _open_beneath(repl_id, rel, os.O_RDONLY)
    with os.fdopen(fd, "rb") as f:
        if os.fstat(f.fileno()).st_size > limit:
            raise _too_large("File", limit)
        # Read one byte past the limit in case the file grew since fstat.
        data = f.read(limit + 1)
    if len(data) > limit:
        raise _too_large("File", limit)
    return data


def read_file(repl_id: str, rel: str) -> dict:
    data = _read_bytes(repl_id, rel)
    try:
        return {"path": rel, "content": data.decode("utf-8"), "encoding": "utf-8"}
    except UnicodeDecodeError:
        return {"path": rel, "content": base64.b64encode(data).decode(), "encoding": "base64"}


def read_text(repl_id: str, rel: str) -> str:
    return _read_bytes(repl_id, rel).decode("utf-8", errors="replace")


def write_file(repl_id: str, rel: str, data: bytes) -> int:
    fd = _open_beneath(repl_id, rel, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, create_parents=True)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
        os.fchown(f.fileno(), RUNNER_UID, RUNNER_GID)
    return len(data)


def create_node(repl_id: str, rel: str, kind: str) -> None:
    with _parent_beneath(repl_id, rel, create_parents=True) as (dir_fd, name):
        try:
            if kind == "dir":
                os.mkdir(name, 0o755, dir_fd=dir_fd)
            else:
                os.close(os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=dir_fd))
        except FileExistsError:
            raise HTTPException(status_code=409, detail="Already exists")
        os.chown(name, RUNNER_UID, RUNNER_GID, dir_fd=dir_fd, follow_symlinks=False)


def _exists_at(dir_fd: int, name: str) -> bool:
    try:
        os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
        return True
    except FileNotFoundError:
        return False


def rename_node(repl_id: str, src: str, dst: str) -> None:
    with _parent_beneath(repl_id, src) as (src_fd, src_name), \
            _parent_beneath(repl_id, dst, create_parents=True) as (dst_fd, dst_name):
        if not _exists_at(src_fd, src_name):
            raise HTTPException(status_code=404, detail="Source not found")
        if _exists_at(dst_fd, dst_name):
            raise HTTPException(status_code=409, detail="Destination exists")
        os.rename(src_name, dst_name, src_dir_fd=src_fd, dst_dir_fd=dst_fd)


def delete_node(repl_id: str, rel: str) -> None:
    with _parent_beneath(repl_id, rel) as (dir_fd, name):
        try:
            st = os.stat(name, dir_fd=dir_fd, follow_symlinks=False)
        except FileNotFoundError:
            raise HTTPException(status_code=404, detail="Not found")
        if stat.S_ISDIR(st.st_mode):
            # rmtree with dir_fd never follows symlinks inside the tree.
            shutil.rmtree(name, dir_fd=dir_fd)
        else:
            os.unlink(name, dir_fd=dir_fd)


MAX_WALK_ENTRIES = 500_000


def disk_usage(path: str | Path, stop_after: int | None = None) -> int:
    """Bytes allocated under `path` (like `du -s`, hard links counted once),
    without following symlinks. Stops early once past `stop_after`; a tree with
    more than MAX_WALK_ENTRIES entries counts as over any limit."""
    total = 0
    entries = 0
    seen: set[tuple[int, int]] = set()
    try:
        for _dirpath, dirnames, filenames, dirfd in os.fwalk(str(path), follow_symlinks=False):
            for n in dirnames + filenames:
                entries += 1
                try:
                    st = os.stat(n, dir_fd=dirfd, follow_symlinks=False)
                except OSError:
                    continue
                if st.st_nlink > 1:
                    if (st.st_dev, st.st_ino) in seen:
                        continue
                    seen.add((st.st_dev, st.st_ino))
                total += st.st_blocks * 512
            if stop_after is not None and (total > stop_after or entries > MAX_WALK_ENTRIES):
                return max(total, stop_after + 1)
    except FileNotFoundError:
        return 0
    return total


def quota_bytes() -> int:
    return settings.REPL_DISK_QUOTA_MB * 1024 * 1024


def check_quota(repl_id: str, adding: int = 0) -> None:
    quota = quota_bytes()
    used = disk_usage(repl_root(repl_id), stop_after=max(quota - adding, 0))
    if used + adding > quota:
        raise HTTPException(
            status_code=413, detail=f"Repl would exceed its {settings.REPL_DISK_QUOTA_MB} MB disk quota"
        )


def zip_repl(repl_id: str) -> str:
    """Zip the repl into a temp file and return its path (caller deletes it).

    Every file is opened relative to its parent's fd with O_NOFOLLOW and
    checked to be a regular file, so a symlink swapped in mid-walk can't make
    root read outside the repl, and a FIFO can't block us. Input is streamed
    in chunks and capped at MAX_ZIP_MB (uncompressed) -> 413.
    """
    limit = settings.MAX_ZIP_MB * 1024 * 1024
    root = str(repl_root(repl_id))
    fd_out, out_path = tempfile.mkstemp(prefix="repl-zip-", suffix=".zip")
    total = 0
    try:
        with os.fdopen(fd_out, "wb") as raw, zipfile.ZipFile(raw, "w", zipfile.ZIP_DEFLATED) as zf:
            for dirpath, dirnames, filenames, dirfd in os.fwalk(root, follow_symlinks=False):
                dirnames[:] = [d for d in dirnames if d != ".git" and not (d == ".repl" and dirpath == root)]
                for f in filenames:
                    try:
                        fd = os.open(f, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dirfd)
                    except OSError:
                        continue  # symlink (ELOOP), vanished, unreadable...
                    try:
                        st = os.fstat(fd)
                        if not stat.S_ISREG(st.st_mode):
                            continue
                        if total + st.st_size > limit:
                            raise _too_large("Download", limit)
                        os.set_blocking(fd, True)
                        arcname = os.path.relpath(os.path.join(dirpath, f), root)
                        # 315532800 = 1980-01-01, the earliest zip timestamp.
                        info = zipfile.ZipInfo(arcname, time.localtime(max(st.st_mtime, 315532800))[:6])
                        info.compress_type = zipfile.ZIP_DEFLATED
                        info.external_attr = (st.st_mode & 0xFFFF) << 16
                        with os.fdopen(fd, "rb", closefd=False) as fh, zf.open(info, "w", force_zip64=True) as dst:
                            while chunk := fh.read(1024 * 1024):
                                total += len(chunk)
                                if total > limit:
                                    raise _too_large("Download", limit)
                                dst.write(chunk)
                    finally:
                        os.close(fd)
    except BaseException:
        os.unlink(out_path)
        raise
    return out_path


def parse_replit(path: Path) -> dict:
    cfg = {"run": None, "entrypoint": None, "gui": False, "port": None, "language": None}
    f = path / ".replit"
    try:
        data = tomllib.loads(f.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError, UnicodeDecodeError):
        return cfg
    if isinstance(data.get("run"), str):
        cfg["run"] = data["run"]
    elif isinstance(data.get("run"), list):
        cfg["run"] = " ".join(str(x) for x in data["run"])
    if isinstance(data.get("entrypoint"), str):
        cfg["entrypoint"] = data["entrypoint"]
    cfg["gui"] = bool(data.get("gui", False))
    if isinstance(data.get("port"), int):
        cfg["port"] = data["port"]
    if isinstance(data.get("language"), str):
        cfg["language"] = data["language"]
    return cfg

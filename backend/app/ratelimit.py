"""In-memory sliding-window rate limits and client IP resolution.

State is per backend process. That is enough for the single-process
deployment in docker-compose.yml; several workers would each keep their own
counters (limits then scale with the worker count).
"""
import ipaddress
import socket
import threading
import time
from collections import deque

from fastapi import HTTPException, Request

from app.config import settings

_MAX_KEYS = 50_000


class SlidingWindow:
    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def _prune(self, key: str, window: float, now: float) -> deque[float]:
        q = self._hits.get(key)
        if q is None:
            return deque()
        while q and q[0] <= now - window:
            q.popleft()
        if not q:
            del self._hits[key]
        return q

    def _sweep(self, now: float, max_window: float) -> None:
        for key in list(self._hits):
            q = self._hits[key]
            if not q or q[-1] <= now - max_window:
                del self._hits[key]

    def retry_after(self, key: str, limit: int, window: float) -> float:
        """Seconds until one more hit fits, or 0 if it fits now."""
        now = time.monotonic()
        with self._lock:
            q = self._prune(key, window, now)
            if len(q) < limit:
                return 0.0
            return max(q[len(q) - limit] + window - now, 1.0)

    def count(self, key: str, window: float) -> int:
        with self._lock:
            return len(self._prune(key, window, time.monotonic()))

    def add(self, key: str) -> None:
        now = time.monotonic()
        with self._lock:
            if len(self._hits) > _MAX_KEYS:
                self._sweep(now, 3600.0)
            self._hits.setdefault(key, deque()).append(now)

    def hit(self, key: str, limit: int, window: float) -> float:
        """Record a hit unless over the limit; returns retry-after (0 = allowed)."""
        now = time.monotonic()
        with self._lock:
            q = self._prune(key, window, now)
            if len(q) >= limit:
                return max(q[len(q) - limit] + window - now, 1.0)
            if len(self._hits) > _MAX_KEYS:
                self._sweep(now, 3600.0)
            self._hits.setdefault(key, q).append(now)
            return 0.0

    def reset(self, key: str) -> None:
        with self._lock:
            self._hits.pop(key, None)

    def clear(self) -> None:
        with self._lock:
            self._hits.clear()


limiter = SlidingWindow()


def too_many(retry_after: float, detail: str = "Too many attempts, try again later") -> HTTPException:
    return HTTPException(status_code=429, detail=detail, headers={"Retry-After": str(int(retry_after + 0.999))})


def enforce(key: str, limit: int, window: float, detail: str | None = None) -> None:
    wait = limiter.hit(key, limit, window)
    if wait:
        raise too_many(wait, detail or "Too many attempts, try again later")


# ---- client IP ----

_trusted_cache: tuple[float, list] = (0.0, [])
_trusted_lock = threading.Lock()
_TRUST_TTL = 30.0


def _trusted_networks() -> list:
    """TRUSTED_PROXIES entries as ip_network objects; hostnames are resolved
    (every address, so a proxy attached to several networks is covered) and
    cached for a short while."""
    global _trusted_cache
    now = time.monotonic()
    with _trusted_lock:
        if now - _trusted_cache[0] < _TRUST_TTL:
            return _trusted_cache[1]
    nets = []
    for entry in settings.TRUSTED_PROXIES.split(","):
        entry = entry.strip()
        if not entry:
            continue
        try:
            nets.append(ipaddress.ip_network(entry, strict=False))
            continue
        except ValueError:
            pass
        try:
            infos = socket.getaddrinfo(entry, None, proto=socket.IPPROTO_TCP)
        except OSError:
            continue
        for info in infos:
            try:
                nets.append(ipaddress.ip_network(info[4][0]))
            except ValueError:
                pass
    with _trusted_lock:
        _trusted_cache = (now, nets)
    return nets


def _is_trusted(addr: str, nets: list) -> bool:
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return False
    return any(ip in n for n in nets)


def client_ip(request: Request) -> str:
    peer = request.client.host if request.client else ""
    nets = _trusted_networks()
    if not peer or not _is_trusted(peer, nets):
        return peer or "unknown"
    # nginx appends its peer ($proxy_add_x_forwarded_for), so walk from the
    # right, skipping our own proxies; the first other hop is the client.
    hops = [h.strip() for h in request.headers.get("x-forwarded-for", "").split(",") if h.strip()]
    for hop in reversed(hops):
        if not _is_trusted(hop, nets):
            try:
                return str(ipaddress.ip_address(hop))
            except ValueError:
                return peer
    return peer

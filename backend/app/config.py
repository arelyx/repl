from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    DATABASE_URL: str = "postgresql+asyncpg://replot:replot@postgres:5432/replot"
    JWT_SECRET_KEY: str = "change-me"
    INTERNAL_SECRET: str = "change-me-internal"
    REPLS_DIR: str = "/var/lib/replot/repls"
    REPLS_HOST_DIR: str = ""
    RUNNER_IMAGE: str = "replit-polyglot:latest"
    REPL_NETWORK: str = "rc-repls"
    PUBLIC_HOST: str = "localhost:8380"
    IDLE_TIMEOUT_MINUTES: int = 30
    REPL_RUNTIME: str = ""
    COOKIE_SECURE: bool = False
    JWT_EXPIRE_DAYS: int = 7
    CORS_ORIGINS: str = "http://localhost:5173"
    COLLAB_COMMAND_URL: str = "http://collaboration:1235"
    # Containers attached to every per-repl network (they proxy to / poll repls).
    GATEWAY_CONTAINERS: str = "replot-nginx,replot-backend"
    # Address space for per-repl /28 networks (4096 repls in a /16).
    REPL_SUBNET_POOL: str = "10.213.0.0/16"

    # --- runtime hardening (S1) ---
    # Per-container resource caps.
    REPL_CPUS: float = 1.0
    REPL_MEMORY: str = "2g"  # memory and memory+swap are both set to this (no swap)
    # Host pids (threads included). Under runc that is the repl's own
    # processes and threads. Under gVisor (runsc, systrap) every guest process
    # costs ~2 host pids and ~3.5 MB, threads almost nothing, and hitting the
    # limit kills the whole sandbox: 512 allows ~230 guest processes, so use
    # ~2048 with runsc and let REPL_MEMORY bound process count instead.
    REPL_PIDS: int = 512
    REPL_TMPFS_SIZE: str = "512m"
    REPL_LOG_MAX_SIZE: str = "5m"
    REPL_LOG_MAX_FILE: int = 2
    # systemd slice every repl container lives under, so the whole fleet can be
    # capped in one place (`systemctl set-property replot-repls.slice
    # CPUQuota=1600% MemoryMax=48G`). Empty = Docker's default parent.
    REPL_CGROUP_PARENT: str = "replot-repls.slice"
    # Running-container caps. Starting past the per-user cap stops that user's
    # least recently active repl(s); past the global cap, start is refused.
    MAX_RUNNING_PER_USER: int = 2
    MAX_RUNNING_REPLS: int = 40
    # Repl directory + container writable layer, checked at start and by the reaper.
    REPL_DISK_QUOTA_MB: int = 2048
    # Hard lifetime of a container regardless of activity.
    MAX_CONTAINER_HOURS: float = 12
    # Throwaway containers that run git for repls that are not running.
    GIT_CONTAINER_MEMORY: str = "512m"
    GIT_CONTAINER_PIDS: int = 128
    GIT_CONTAINER_CPUS: float = 1.0
    # --- end runtime hardening (S1) ---

    @property
    def repls_host_dir(self) -> str:
        return self.REPLS_HOST_DIR or self.REPLS_DIR

    @property
    def async_database_url(self) -> str:
        url = self.DATABASE_URL
        for prefix in ("postgresql://", "postgres://"):
            if url.startswith(prefix):
                return "postgresql+asyncpg://" + url[len(prefix):]
        return url


settings = Settings()

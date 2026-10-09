from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Secrets that ship in .env.example / older defaults; never acceptable.
_KNOWN_DEFAULT_SECRETS = {
    "", "change-me", "change-me-internal", "change-me-too", "change-me-to-a-long-random-string",
    "secret", "changeme", "password", "replot", "postgres",
}
_MIN_SECRET_LEN = 32


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
    # gVisor: user code never talks to the host kernel directly. Empty = runc.
    REPL_RUNTIME: str = "runsc"
    COLLAB_COMMAND_URL: str = "http://collaboration:1235"
    # Containers attached to every per-repl network (they proxy to / poll repls).
    GATEWAY_CONTAINERS: str = "replot-nginx,replot-backend"
    # Address space for per-repl /28 networks (4096 repls in a /16).
    REPL_SUBNET_POOL: str = "10.213.0.0/16"

    # --- app hardening (S2) ---
    # "development" re-enables /api/v1/docs and skips the database password check.
    APP_ENV: str = "production"
    # Scheme the app is served on publicly (http | https). https turns on
    # Secure + __Host- cookies by default and https preview URLs.
    PUBLIC_SCHEME: str = "http"
    # Host previews are served under ({id}-{port}.preview.<PREVIEW_HOST>).
    # Defaults to PUBLIC_HOST; a separate registrable domain is recommended.
    PREVIEW_HOST: str = ""
    # Unset = follow PUBLIC_SCHEME.
    COOKIE_SECURE: bool | None = None
    JWT_EXPIRE_DAYS: int = 7
    # Comma-separated extra origins allowed to call the API with credentials.
    # Empty = same-origin only (the normal deployment behind nginx).
    CORS_ORIGINS: str = ""
    ALLOW_SIGNUP: bool = True
    # Peers whose X-Forwarded-For is believed: hostnames (resolved) or CIDRs.
    TRUSTED_PROXIES: str = "replot-nginx"
    AUTH_RATE_PER_MIN: int = 10          # login + register attempts per client IP
    REGISTER_RATE_PER_HOUR: int = 5      # successful-or-not sign-ups per client IP
    LOGIN_MAX_FAILURES: int = 5          # failed logins per account ...
    LOGIN_FAILURE_WINDOW_MIN: int = 15   # ... within this window, then 429
    MAX_REPLS_PER_USER: int = 50
    REPL_DISK_QUOTA_MB: int = 2048       # shared with the runtime reaper
    MAX_FILE_READ_MB: int = 10
    MAX_UPLOAD_MB: int = 50
    MAX_ZIP_MB: int = 500
    MAX_GIT_OUTPUT_MB: int = 2

    @field_validator("COOKIE_SECURE", mode="before")
    @classmethod
    def _blank_is_auto(cls, v):
        # docker compose passes COOKIE_SECURE= (empty) when unset.
        return None if isinstance(v, str) and not v.strip() else v

    @property
    def is_development(self) -> bool:
        return self.APP_ENV.strip().lower() in ("development", "dev")

    @property
    def public_scheme(self) -> str:
        return "https" if self.PUBLIC_SCHEME.strip().lower() == "https" else "http"

    @property
    def cookie_secure(self) -> bool:
        if self.COOKIE_SECURE is None:
            return self.public_scheme == "https"
        return self.COOKIE_SECURE

    @property
    def cookie_name(self) -> str:
        # __Host- cookies must be Secure, Path=/ and host-only, so a preview
        # subdomain can't toss one in for the app.
        return "__Host-access_token" if self.cookie_secure else "access_token"

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]

    def preview_base(self, repl_id: str) -> str:
        host = self.PREVIEW_HOST.strip() or self.PUBLIC_HOST
        return f"{self.public_scheme}://{repl_id}-{{port}}.preview.{host}"

    def secret_problems(self) -> list[str]:
        problems = []
        for name in ("JWT_SECRET_KEY", "INTERNAL_SECRET"):
            value = getattr(self, name) or ""
            if value.strip().lower() in _KNOWN_DEFAULT_SECRETS or value.startswith("change-me"):
                problems.append(f"{name} is missing or a known default")
            elif len(value) < _MIN_SECRET_LEN:
                problems.append(f"{name} is shorter than {_MIN_SECRET_LEN} characters")
        if not self.is_development:
            from sqlalchemy.engine import make_url

            try:
                password = make_url(self.async_database_url).password or ""
            except Exception:
                password = ""
            if password.strip().lower() in _KNOWN_DEFAULT_SECRETS or password.startswith("change-me"):
                problems.append("the database password (POSTGRES_PASSWORD / DATABASE_URL) is missing or a known default")
        if self.PUBLIC_SCHEME.strip().lower() not in ("http", "https"):
            problems.append("PUBLIC_SCHEME must be http or https")
        return problems
    # --- runtime hardening (S1) ---
    # Per-container resource caps.
    REPL_CPUS: float = 1.0
    REPL_MEMORY: str = "2g"  # memory and memory+swap are both set to this (no swap)
    # Host pids (threads included). Under runc that is the repl's own
    # processes and threads. Under gVisor (runsc, systrap) every guest process
    # costs ~2 host pids and ~3.5 MB, threads almost nothing, and hitting the
    # limit kills the whole sandbox: 512 allows ~230 guest processes, so use
    # ~2048 with runsc and let REPL_MEMORY bound process count instead.
    REPL_PIDS: int = 2048
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
    # REPL_DISK_QUOTA_MB (app hardening block above) is the repl directory +
    # container writable layer limit, checked at start and by the reaper.
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

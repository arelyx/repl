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
    REPL_RUNTIME: str = ""
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

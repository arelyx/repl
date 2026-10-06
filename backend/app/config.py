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

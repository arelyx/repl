import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import models  # noqa: F401  (register tables)
from app.config import settings
from app.database import Base, engine
from app.routers import auth, files, internal, repls
from app.services import runtime

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("replot")


async def _init_db() -> None:
    for attempt in range(30):
        try:
            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)
            return
        except Exception as e:  # postgres not up yet
            log.warning("DB not ready (%s), retrying...", e)
            await asyncio.sleep(2)
    raise RuntimeError("Database unavailable")


@asynccontextmanager
async def lifespan(app: FastAPI):
    Path(settings.REPLS_DIR).mkdir(parents=True, exist_ok=True)
    await _init_db()
    reaper = asyncio.create_task(runtime.reaper_loop())
    yield
    reaper.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await reaper
    await engine.dispose()


app = FastAPI(title="Replot API", lifespan=lifespan, docs_url="/api/v1/docs", openapi_url="/api/v1/openapi.json")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.CORS_ORIGINS.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

PREFIX = "/api/v1"


@app.get(f"{PREFIX}/health")
async def health():
    return {"status": "ok"}


app.include_router(auth.router, prefix=PREFIX)
app.include_router(repls.router, prefix=PREFIX)
app.include_router(files.router, prefix=PREFIX)
app.include_router(internal.router, prefix=PREFIX)

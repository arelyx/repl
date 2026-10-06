"""Tell the collaboration server that files changed on disk behind its back
(git restore, rename, delete, upload, REST saves), so open Yjs rooms reload
from disk instead of later overwriting the change with stale text."""
import logging

import httpx

from app.config import settings

log = logging.getLogger(__name__)


async def reload_repl(repl_id: str) -> None:
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            await client.post(
                f"{settings.COLLAB_COMMAND_URL}/reload",
                json={"repl_id": repl_id},
                headers={"X-Internal-Secret": settings.INTERNAL_SECRET},
            )
    except httpx.HTTPError as e:
        # Best effort: with no open rooms there is nothing to reload anyway.
        log.warning("collab reload for %s failed: %s", repl_id, e)

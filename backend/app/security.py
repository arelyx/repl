from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import Depends, HTTPException, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.models import User

SECURE_COOKIE_NAME = "__Host-access_token"
PLAIN_COOKIE_NAME = "access_token"

# Checked against when the login names no user, so a miss costs as much as a
# wrong password (same bcrypt cost as hash_password).
_DUMMY_HASH = bcrypt.hashpw(b"repl-dummy-password", bcrypt.gensalt()).decode()


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, hashed: str | None) -> bool:
    try:
        ok = bcrypt.checkpw(password.encode(), (hashed or _DUMMY_HASH).encode())
    except ValueError:
        return False
    return ok and hashed is not None


def create_token(user: User) -> str:
    exp = datetime.now(timezone.utc) + timedelta(days=settings.JWT_EXPIRE_DAYS)
    payload = {"sub": str(user.id), "tv": user.token_version or 0, "exp": exp}
    return jwt.encode(payload, settings.JWT_SECRET_KEY, algorithm="HS256")


def set_auth_cookie(response: Response, user: User) -> None:
    response.set_cookie(
        settings.cookie_name,
        create_token(user),
        max_age=settings.JWT_EXPIRE_DAYS * 86400,
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
        path="/",
    )


def clear_auth_cookie(response: Response) -> None:
    response.delete_cookie(SECURE_COOKIE_NAME, path="/", httponly=True, samesite="lax", secure=True)
    response.delete_cookie(PLAIN_COOKIE_NAME, path="/", httponly=True, samesite="lax", secure=settings.cookie_secure)


def token_from_request(request: Request) -> str | None:
    # The __Host- cookie can only have been set by the app host over https,
    # so it always wins. The plain name is honoured only when the deployment
    # doesn't use secure cookies: under https, a plain cookie may have been
    # tossed in by a preview subdomain (session fixation).
    token = request.cookies.get(SECURE_COOKIE_NAME)
    if token:
        return token
    if not settings.cookie_secure:
        return request.cookies.get(PLAIN_COOKIE_NAME)
    return None


def decode_token(token: str | None) -> tuple[int, int] | None:
    """(user_id, token_version) from a valid token, else None."""
    if not token:
        return None
    try:
        payload = jwt.decode(token, settings.JWT_SECRET_KEY, algorithms=["HS256"], options={"require": ["exp", "sub"]})
        return int(payload["sub"]), int(payload.get("tv", 0))
    except (jwt.PyJWTError, KeyError, ValueError, TypeError):
        return None


async def get_optional_user(request: Request, db: AsyncSession = Depends(get_db)) -> User | None:
    decoded = decode_token(token_from_request(request))
    if decoded is None:
        return None
    uid, tv = decoded
    user = await db.get(User, uid)
    if user is None or (user.token_version or 0) != tv:
        return None  # deleted account, or token revoked by logout / password change
    return user


async def get_current_user(user: User | None = Depends(get_optional_user)) -> User:
    if user is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user

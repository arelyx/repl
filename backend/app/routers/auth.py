import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.config import settings
from app.database import get_db
from app.models import User
from app.ratelimit import client_ip, enforce, limiter, too_many
from app.schemas import LoginIn, PasswordChangeIn, RegisterIn, UserOut
from app.security import (
    clear_auth_cookie,
    get_current_user,
    get_optional_user,
    hash_password,
    set_auth_cookie,
    verify_password,
)

router = APIRouter(prefix="/auth", tags=["auth"])

# Usernames are public (shown on repls); emails are not. One message for both
# conflicts, so sign-up can't be used to test whether an email has an account.
TAKEN = "That username or email can't be used. Pick another username, or log in if you already have an account."


def _ip_limits(request: Request, action: str) -> None:
    ip = client_ip(request)
    enforce(f"auth-ip:{ip}", settings.AUTH_RATE_PER_MIN, 60.0)
    if action == "register":
        enforce(f"register-ip:{ip}", settings.REGISTER_RATE_PER_HOUR, 3600.0, "Too many sign-ups from this address, try again later")


@router.post("/register", response_model=UserOut)
async def register(body: RegisterIn, request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    if not settings.ALLOW_SIGNUP:
        raise HTTPException(status_code=403, detail="Sign-up is disabled on this server")
    _ip_limits(request, "register")
    email = body.email.lower()
    # Hash before looking anything up, so taken and free names cost the same.
    password_hash = await run_in_threadpool(hash_password, body.password)
    existing = await db.execute(
        select(User.id).where(or_(func.lower(User.email) == email, func.lower(User.username) == body.username.lower()))
    )
    if existing.first() is not None:
        raise HTTPException(status_code=409, detail=TAKEN)
    user = User(
        email=email,
        username=body.username,
        password_hash=password_hash,
        display_name=(body.display_name or "").strip() or body.username,
        token_version=0,
    )
    db.add(user)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail=TAKEN)
    await db.refresh(user)
    set_auth_cookie(response, user)
    return user


def _account_key(user: User | None, ident: str) -> str:
    # Key by user id when the account exists so email and username share one
    # budget; unknown names get the same treatment (no enumeration by 429s).
    return f"login-fail:{user.id}" if user else f"login-fail:?{ident}"


@router.post("/login", response_model=UserOut)
async def login(body: LoginIn, request: Request, response: Response, db: AsyncSession = Depends(get_db)):
    _ip_limits(request, "login")
    ident = body.login.strip().lower()
    res = await db.execute(
        select(User).where(or_(func.lower(User.email) == ident, func.lower(User.username) == ident))
    )
    user = res.scalars().first()
    key = _account_key(user, ident)
    window = settings.LOGIN_FAILURE_WINDOW_MIN * 60.0
    wait = limiter.retry_after(key, settings.LOGIN_MAX_FAILURES, window)
    if wait:
        raise too_many(wait, "Too many failed logins for this account, try again later")
    ok = await run_in_threadpool(verify_password, body.password, user.password_hash if user else None)
    if not ok:
        limiter.add(key)
        # Growing delay per recent failure (0.25s, 0.5s, 1s, 2s, ...): slows a
        # single attacker's loop without holding a worker.
        fails = limiter.count(key, window)
        await asyncio.sleep(min(0.25 * 2 ** (fails - 1), 4.0))
        raise HTTPException(status_code=401, detail="Invalid credentials")
    limiter.reset(key)
    set_auth_cookie(response, user)
    return user


@router.post("/logout", status_code=204)
async def logout(user: User | None = Depends(get_optional_user), db: AsyncSession = Depends(get_db)):
    if user is not None:
        # Revokes every token this account holds (all devices).
        await db.execute(update(User).where(User.id == user.id).values(token_version=User.token_version + 1))
        await db.commit()
    response = Response(status_code=204)
    clear_auth_cookie(response)
    return response


@router.post("/password", response_model=UserOut)
async def change_password(
    body: PasswordChangeIn,
    request: Request,
    response: Response,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    enforce(f"auth-ip:{client_ip(request)}", settings.AUTH_RATE_PER_MIN, 60.0)
    key = f"login-fail:{user.id}"
    window = settings.LOGIN_FAILURE_WINDOW_MIN * 60.0
    wait = limiter.retry_after(key, settings.LOGIN_MAX_FAILURES, window)
    if wait:
        raise too_many(wait, "Too many failed attempts for this account, try again later")
    if not await run_in_threadpool(verify_password, body.current_password, user.password_hash):
        limiter.add(key)
        raise HTTPException(status_code=403, detail="Current password is incorrect")
    new_hash = await run_in_threadpool(hash_password, body.new_password)
    user = await db.merge(user)
    user.password_hash = new_hash
    user.token_version = (user.token_version or 0) + 1
    await db.commit()
    await db.refresh(user)
    # Other sessions are revoked; this one gets a fresh token.
    set_auth_cookie(response, user)
    return user


@router.get("/me", response_model=UserOut)
async def me(user: User = Depends(get_current_user)):
    return user

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import User
from app.schemas import LoginIn, RegisterIn, UserOut
from app.security import clear_auth_cookie, get_current_user, hash_password, set_auth_cookie, verify_password

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=UserOut)
async def register(body: RegisterIn, response: Response, db: AsyncSession = Depends(get_db)):
    email = body.email.lower()
    existing = await db.execute(
        select(User).where(or_(func.lower(User.email) == email, func.lower(User.username) == body.username.lower()))
    )
    if existing.scalars().first():
        raise HTTPException(status_code=409, detail="Email or username already taken")
    user = User(
        email=email,
        username=body.username,
        password_hash=hash_password(body.password),
        display_name=(body.display_name or "").strip() or body.username,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    set_auth_cookie(response, user.id)
    return user


@router.post("/login", response_model=UserOut)
async def login(body: LoginIn, response: Response, db: AsyncSession = Depends(get_db)):
    ident = body.login.strip().lower()
    res = await db.execute(
        select(User).where(or_(func.lower(User.email) == ident, func.lower(User.username) == ident))
    )
    user = res.scalars().first()
    if user is None or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    set_auth_cookie(response, user.id)
    return user


@router.post("/logout", status_code=204)
async def logout(response: Response):
    clear_auth_cookie(response)
    response.status_code = 204
    return response


@router.get("/me", response_model=UserOut)
async def me(user: User = Depends(get_current_user)):
    return user

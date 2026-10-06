from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    email: str
    username: str
    display_name: str


class RegisterIn(BaseModel):
    email: EmailStr
    username: str = Field(min_length=2, max_length=32, pattern=r"^[A-Za-z0-9_-]+$")
    password: str = Field(min_length=6, max_length=128)
    display_name: str | None = Field(default=None, max_length=255)


class LoginIn(BaseModel):
    login: str
    password: str


class OwnerOut(BaseModel):
    id: int
    username: str
    display_name: str


class ReplConfig(BaseModel):
    run: str | None = None
    entrypoint: str | None = None
    gui: bool = False
    port: int | None = None


class ReplOut(BaseModel):
    id: str
    name: str
    description: str
    template: str
    language: str
    is_public: bool
    owner: OwnerOut
    role: Literal["owner", "editor", "viewer"]
    forked_from: str | None
    created_at: datetime
    updated_at: datetime
    config: ReplConfig


class ReplCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    template: str
    description: str | None = ""
    is_public: bool = False


class ReplUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None
    is_public: bool | None = None


class ForkIn(BaseModel):
    name: str | None = None


class FileWrite(BaseModel):
    path: str
    content: str


class FileCreate(BaseModel):
    path: str
    type: Literal["file", "dir"] = "file"


class FileRename(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    from_: str = Field(alias="from")
    to: str


class CommitIn(BaseModel):
    message: str = Field(min_length=1)


class RestoreIn(BaseModel):
    sha: str
    path: str | None = None


class CollaboratorIn(BaseModel):
    username: str
    role: Literal["viewer", "editor"] = "viewer"


class InternalFileWrite(BaseModel):
    repl_id: str
    path: str
    content: str

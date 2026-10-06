from fastapi import FastAPI
from fastapi.responses import HTMLResponse

app = FastAPI()


@app.get("/", response_class=HTMLResponse)
def index():
    return "<h1>Hello from FastAPI!</h1><p>See the docs at <a href='/docs'>/docs</a></p>"


@app.get("/api/hello")
def hello(name: str = "world"):
    return {"message": f"Hello, {name}!"}

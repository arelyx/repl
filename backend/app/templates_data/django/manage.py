"""A whole Django project in one file. Run: python3 manage.py runserver 0.0.0.0:8000"""
import sys

from django.conf import settings
from django.http import HttpResponse, JsonResponse
from django.urls import path

settings.configure(
    DEBUG=True,
    SECRET_KEY="replot-dev-only",
    ALLOWED_HOSTS=["*"],
    ROOT_URLCONF=__name__,
    MIDDLEWARE=[],
    INSTALLED_APPS=[],
)


def index(request):
    return HttpResponse("<h1>Hello from Django!</h1><p>Try <a href='/api/hello'>/api/hello</a></p>")


def hello(request):
    return JsonResponse({"message": "Hello, world!"})


urlpatterns = [
    path("", index),
    path("api/hello", hello),
]

if __name__ == "__main__":
    from django.core.management import execute_from_command_line

    execute_from_command_line(sys.argv)

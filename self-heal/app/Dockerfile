ARG PYTHON_VERSION=3.13.17
FROM python:${PYTHON_VERSION}-slim-trixie

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Standard library only: nothing is installed.
WORKDIR /app
COPY controller.py test_controller.py ./

USER 1000:1000
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8790/healthz', timeout=4).status == 200 else 1)"]
CMD ["python", "/app/controller.py"]

# MCP server that lets the Hermes `models` profile start and read benchmark runs.
FROM python:3.13.17-slim-trixie

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN pip install --root-user-action=ignore -r /app/requirements.txt
COPY server.py /app/server.py

USER 65534:65534
EXPOSE 8793
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8793/healthz', timeout=3)"]
CMD ["python", "-I", "/app/server.py"]

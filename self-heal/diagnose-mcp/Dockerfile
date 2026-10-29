# Read-only MCP diagnosis server for the self-heal devops-diagnose profile.
FROM python:3.13.17-slim-trixie

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# git reads committed compose files from the read-only repository mount.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN pip install --root-user-action=ignore -r /app/requirements.txt
COPY server.py /app/server.py

USER 65534:65534
EXPOSE 8791
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8791/healthz', timeout=3)"]
CMD ["python", "-I", "/app/server.py"]

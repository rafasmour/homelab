# Read-only host snapshot service (standard library only).
FROM python:3.13.17-slim-trixie

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY probe.py /app/probe.py

USER 65534:65534
EXPOSE 8792
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8792/healthz', timeout=3)"]
CMD ["python", "-I", "/app/probe.py"]

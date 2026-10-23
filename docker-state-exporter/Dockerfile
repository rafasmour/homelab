FROM python:3.12-alpine

COPY app/exporter.py /app/exporter.py

USER nobody
EXPOSE 9417
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:9417/healthz >/dev/null || exit 1
CMD ["python", "/app/exporter.py"]

FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir aiohttp==3.14.3 wyoming==1.10.2 numpy==2.5.4 onnxruntime==1.31.1 \
    && useradd -r -u 10001 gateway

COPY server.py lid.py tester.html /app/
USER gateway
EXPOSE 8000
CMD ["python", "/app/server.py"]

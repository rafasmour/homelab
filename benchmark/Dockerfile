# Benchmark runner: Node.js for the harness, Python + openpyxl for the Excel
# export, and the static Docker CLI to drive `docker exec` through the
# mounted host socket.
FROM node:24-slim

ARG DOCKER_VERSION=29.0.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl procps python3 python3-openpyxl \
    && curl -fsSL "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_VERSION}.tgz" \
       | tar -xz -C /usr/local/bin --strip-components=1 docker/docker \
    && apt-get purge -y curl \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json main.js api.js ./
COPY lib/ ./lib/
COPY benchmarks/ ./benchmarks/

CMD ["node", "--disable-warning=ExperimentalWarning", "api.js"]

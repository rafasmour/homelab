# SSH sandboxes for the Hermes terminal/file tools. One image per target:
#   docker compose build   (targets: coding, devops, models, llamacpp)
# Every target runs sshd as root (key-only, AllowUsers hermes) and nothing
# else; the agent logs in as the unprivileged user `hermes` (uid 1000).

ARG DEBIAN_IMAGE=debian:13.7-slim
ARG NODE_IMAGE=node:24.22.1-trixie-slim
ARG DOCKER_CLI_IMAGE=docker:29.9.2-cli

FROM ${DOCKER_CLI_IMAGE} AS dockercli
FROM ${NODE_IMAGE} AS node

FROM ${DEBIAN_IMAGE} AS base
ARG HERMES_UID=1000
ARG HERMES_GID=1000
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      openssh-server ca-certificates curl git ripgrep jq python3 less procps \
      bash-completion file tree unzip xz-utils \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /etc/ssh/ssh_host_* \
 && groupadd -g "${HERMES_GID}" hermes \
 && useradd -m -u "${HERMES_UID}" -g "${HERMES_GID}" -s /bin/bash hermes \
 # "*" = no password, but not a locked account (sshd refuses locked ones).
 && usermod -p '*' hermes \
 && install -d -m 0755 /run/sshd /etc/ssh/authorized_keys /etc/ssh/hostkey
COPY sshd_config /etc/ssh/sshd_config.d/00-sandbox.conf
COPY entrypoint.sh /usr/local/sbin/sandbox-entrypoint
RUN chmod 0755 /usr/local/sbin/sandbox-entrypoint
EXPOSE 22
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bash -c 'exec 3<>/dev/tcp/127.0.0.1/22 && head -c 4 <&3 | grep -q SSH'
ENTRYPOINT ["/usr/local/sbin/sandbox-entrypoint"]

# --- coding: compilers, Node.js LTS, Python venv/pip -------------------------
FROM base AS coding
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential pkg-config python3-venv python3-pip python3-dev sqlite3 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
 && node --version && npm --version

# --- devops: Docker CLI + Compose plugin (host socket and the testbed) -------
FROM base AS devops
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
COPY testbed-docker /usr/local/bin/testbed-docker
RUN chmod 0755 /usr/local/bin/testbed-docker && docker --version && docker compose version \
 && su hermes -s /bin/sh -c "docker context create testbed --description 'Disposable DinD testbed (agent-testbed)' --docker host=tcp://agent-testbed:2375" 

# --- models: Hugging Face CLI, gguf, Docker CLI (restart via socket proxy) ---
FROM base AS models
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3-venv python3-pip \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/hf \
 && /opt/hf/bin/pip install --no-cache-dir "huggingface_hub[cli,hf_xet]" gguf \
 && ln -s /opt/hf/bin/hf /usr/local/bin/hf \
 && ln -s /opt/hf/bin/gguf-dump /usr/local/bin/gguf-dump \
 && ln -s /opt/hf/bin/python /usr/local/bin/hf-python \
 && hf version
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker

# --- llamacpp: read-only llama.cpp clone kept fresh by a root-side loop -----
FROM base AS llamacpp
RUN apt-get update \
 && apt-get install -y --no-install-recommends util-linux \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 1001 repo && useradd -M -u 1001 -g 1001 -d /repo -s /usr/sbin/nologin repo \
 # git refuses repositories owned by another user unless they are marked safe.
 && git config --system safe.directory /repo
COPY llamacpp-init.sh /usr/local/libexec/sandbox-init
COPY repo-pull /usr/local/bin/repo-pull
RUN chmod 0755 /usr/local/libexec/sandbox-init /usr/local/bin/repo-pull

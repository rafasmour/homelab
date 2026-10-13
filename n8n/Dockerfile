ARG N8N_VERSION=latest
FROM docker.n8n.io/n8nio/n8n:${N8N_VERSION}

USER root
WORKDIR /scripts
COPY scripts/package.json scripts/package-lock.json ./
RUN npm ci --omit=dev && chown -R node:node /scripts
USER node

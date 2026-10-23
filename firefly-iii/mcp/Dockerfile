ARG NODE_VERSION=22-alpine
FROM node:${NODE_VERSION}

ARG FIREFLY_MCP_VERSION=1.4.0
# Install at build time so the container never downloads at start
# (the backend network has no internet access).
RUN npm install -g "@firefly-iii-mcp/server@${FIREFLY_MCP_VERSION}" && npm cache clean --force

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null || exit 1
ENTRYPOINT ["firefly-iii-mcp-server"]

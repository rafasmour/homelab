FROM node:22-alpine

ARG DRAWIO_MCP_VERSION=1.5.0
ARG SUPERGATEWAY_VERSION=3.4.3

RUN npm install --global \
      "@drawio/mcp@${DRAWIO_MCP_VERSION}" \
      "supergateway@${SUPERGATEWAY_VERSION}" \
    && npm cache clean --force

USER node

EXPOSE 8000

ENTRYPOINT ["supergateway"]
CMD ["--stdio", "drawio-mcp", "--outputTransport", "streamableHttp", "--host", "0.0.0.0", "--port", "8000", "--streamableHttpPath", "/mcp", "--healthEndpoint", "/healthz", "--logLevel", "info"]

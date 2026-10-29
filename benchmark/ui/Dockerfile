# benchmark-ui: Node built-ins only (node:http + node:sqlite), no npm install.
FROM node:24-slim

ENV NODE_ENV=production PORT=8080 BENCH_DB=/data/benchmark.db REPORTS_DIR=/reports
WORKDIR /app
COPY server.js ./
COPY public/ ./public/

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]

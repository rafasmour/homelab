#!/bin/sh
# Start the testbed stacks (idempotent). broken-compose is never started.
# Runs inside agent-testbed against its own daemon, or anywhere with
# DOCKER_HOST=tcp://agent-testbed:2375.
set -u
dir=$(cd "$(dirname "$0")" && pwd)
status=0
for stack in web-ok crashloop unhealthy log-spam env-secret; do
  if ! docker compose -p "${stack}" -f "${dir}/stacks/${stack}/docker-compose.yml" up -d --quiet-pull; then
    echo "seed: ${stack} failed to start" >&2
    status=1
  fi
done
exit "${status}"

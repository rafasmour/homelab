#!/bin/sh
# agent-testbed: start dockerd (plain TCP on the private testbed network
# only), wait for it, seed the stacks, then wait on dockerd.
set -u
touch /.testbed
dockerd-entrypoint.sh dockerd \
  --host=unix:///var/run/docker.sock --host=tcp://0.0.0.0:2375 \
  --tls=false --log-level=warn &
pid=$!
i=0
until docker info >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "${i}" -ge 60 ] || ! kill -0 "${pid}" 2>/dev/null; then
    echo "testbed: dockerd did not start" >&2
    exit 1
  fi
  sleep 1
done
/homelab/hermes-sandboxes/testbed/seed.sh || echo "testbed: seeding incomplete" >&2
wait "${pid}"

#!/bin/sh
# Restore the testbed to its initial state: remove every container, volume,
# and user network on the testbed daemon (never the host daemon), then seed.
#   docker exec agent-testbed /homelab/hermes-sandboxes/testbed/reset.sh
set -u
case "${DOCKER_HOST:-unix:///var/run/docker.sock}" in
  unix:///var/run/docker.sock)
    # Only inside the DinD container: refuse to wipe a real host daemon.
    if [ ! -f /.testbed ]; then
      echo "reset: refusing to run against a local daemon outside agent-testbed" >&2
      exit 1
    fi ;;
  tcp://agent-testbed:2375) ;;
  *) echo "reset: DOCKER_HOST must be the testbed" >&2; exit 1 ;;
esac
ids=$(docker ps -aq)
[ -n "${ids}" ] && docker rm -f ${ids} >/dev/null
docker volume prune -af >/dev/null
docker network prune -f >/dev/null
exec "$(dirname "$0")/seed.sh"

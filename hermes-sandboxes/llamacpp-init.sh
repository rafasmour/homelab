#!/bin/sh
# sbx-llamacpp background job (root). Keeps /repo, a clone of llama.cpp owned
# by the `repo` user, fresh: clone when missing, `git pull --ff-only` every
# REPO_PULL_INTERVAL seconds, and on request from /usr/local/bin/repo-pull
# (the hermes user touches /run/repo-pull/req/request). hermes can read /repo
# but never write it.
set -u
REPO_URL="${REPO_URL:-https://github.com/ggml-org/llama.cpp.git}"
INTERVAL="${REPO_PULL_INTERVAL:-1800}"
state=/run/repo-pull

install -d -m 0755 -o root -g root "${state}"
install -d -m 0730 -o root -g hermes "${state}/req"
chown repo:repo /repo
chmod 0755 /repo

as_repo() {
  setpriv --reuid=repo --regid=repo --init-groups env HOME=/repo "$@"
}

pull() {
  {
    date -u '+%Y-%m-%dT%H:%M:%SZ'
    if [ ! -d /repo/.git ]; then
      echo "cloning ${REPO_URL}"
      rm -rf /repo/.clone-tmp
      as_repo git clone --quiet "${REPO_URL}" /repo/.clone-tmp \
        && as_repo sh -c 'mv /repo/.clone-tmp/.git /repo/.git && rm -rf /repo/.clone-tmp && git -C /repo reset --quiet --hard'
    else
      as_repo git -C /repo pull --ff-only 2>&1
    fi
    echo "HEAD: $(git -C /repo log -1 --format='%h %cs %s' 2>/dev/null)"
  } > "${state}/last.log" 2>&1
  chmod 0644 "${state}/last.log"
  date +%s > "${state}/done"
  chmod 0644 "${state}/done"
}

last=0
while :; do
  now=$(date +%s)
  if [ -e "${state}/req/request" ] || [ $((now - last)) -ge "${INTERVAL}" ]; then
    rm -f "${state}/req/request"
    pull
    last=$(date +%s)
  fi
  sleep 2
done

#!/bin/sh
# Sandbox entrypoint (root): install the pinned host key and the one allowed
# client public key from /keys (read-only mount), pass selected container
# variables into SSH sessions, run the optional per-image init, start sshd.
set -eu

if [ ! -s /keys/ssh_host_ed25519_key ] || [ ! -s /keys/authorized_keys ]; then
  echo "sandbox: /keys/ssh_host_ed25519_key or /keys/authorized_keys is missing; run hermes-sandboxes/setup-keys.sh" >&2
  exit 1
fi
install -m 0600 -o root -g root /keys/ssh_host_ed25519_key /etc/ssh/hostkey/ssh_host_ed25519_key
install -m 0644 -o root -g root /keys/ssh_host_ed25519_key.pub /etc/ssh/hostkey/ssh_host_ed25519_key.pub
install -m 0644 -o root -g root /keys/authorized_keys /etc/ssh/authorized_keys/hermes

# sshd sessions do not inherit the container environment. SANDBOX_SESSION_ENV
# names the variables to forward (values must not contain double quotes or
# spaces). sshd keeps only the first SetEnv line, so all go on one line.
line=""
for name in ${SANDBOX_SESSION_ENV:-}; do
  value=$(printenv "${name}" 2>/dev/null || true)
  if [ -n "${value}" ]; then
    line="${line} ${name}=\"${value}\""
  fi
done
umask 077
if [ -n "${line}" ]; then
  printf 'SetEnv%s\n' "${line}" > /etc/ssh/sandbox-env.conf
else
  : > /etc/ssh/sandbox-env.conf
fi
umask 022

# sshd sessions get their groups from /etc/group, not from compose group_add:
# give hermes the host Docker socket group when the socket is mounted.
if [ -n "${DOCKER_SOCKET_GID:-}" ] && [ -S /var/run/docker.sock ]; then
  group=$(getent group "${DOCKER_SOCKET_GID}" | cut -d: -f1)
  if [ -z "${group}" ]; then
    group=docker-host
    groupadd -g "${DOCKER_SOCKET_GID}" "${group}"
  fi
  usermod -aG "${group}" hermes
fi

# Shared home: Hermes syncs ~/.hermes (skills/cache) here over scp.
chown hermes:hermes /home/hermes
chmod 0750 /home/hermes

if [ -x /usr/local/libexec/sandbox-init ]; then
  /usr/local/libexec/sandbox-init &
fi

/usr/sbin/sshd -t
exec /usr/sbin/sshd -D -e

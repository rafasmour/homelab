#!/bin/sh
# Idempotent SSH key setup for the Hermes sandboxes. Run from anywhere:
#   hermes-sandboxes/setup-keys.sh
#
# - Host keys (pinned) live in hermes-sandboxes/keys/sandbox/<sandbox>/ and are
#   mounted read-only into that sandbox, with its authorized_keys.
# - One client key per profile is generated in the Hermes data folder
#   (hermes/data/sandbox-keys/<profile>/ = /home/hermes/.hermes/sandbox-keys/
#   in hermes-api; override with HERMES_DATA_DIR) by a one-off container and
#   owned by HERMES_UID; the folder is ignored by Git. Each sandbox authorizes
#   exactly one profile key, and each profile gets a known_hosts file holding
#   only its sandbox's host key.
# Recreate the sandboxes after a key change: docker compose up -d --force-recreate
set -eu
here=$(cd "$(dirname "$0")" && pwd)
data_dir="${HERMES_DATA_DIR:-${here}/../hermes/data}"
uid="${HERMES_UID:-1000}"
gid="${HERMES_GID:-1000}"
# profile:sandbox
pairs="models:sbx-models llamacpp-rocm:sbx-llamacpp hf-models:sbx-hf-models"

# Create the data folder as the invoking user if it is missing (Docker would
# create a missing bind source as root).
mkdir -p "${data_dir}"
data_dir=$(cd "${data_dir}" && pwd)

umask 077
for pair in ${pairs}; do
  sbx=${pair#*:}
  dir="${here}/keys/sandbox/${sbx}"
  mkdir -p "${dir}"
  if [ ! -s "${dir}/ssh_host_ed25519_key" ]; then
    ssh-keygen -q -t ed25519 -N '' -C "${sbx}" -f "${dir}/ssh_host_ed25519_key"
  fi
done
chmod 700 "${here}/keys" "${here}/keys/sandbox"

docker run --rm -i --network none --user 0:0 --entrypoint sh \
  -v "${data_dir}:/data" -v "${here}/keys/sandbox:/keys" \
  -e PAIRS="${pairs}" -e OWNER="${uid}:${gid}" -e HOST_OWNER="$(id -u):$(id -g)" \
  "${SETUP_IMAGE:-hermes-sandbox-models:local}" -s <<'SH'
set -eu
umask 077
for pair in ${PAIRS}; do
  profile=${pair%%:*}
  sbx=${pair#*:}
  dir="/data/sandbox-keys/${profile}"
  mkdir -p "${dir}"
  if [ ! -s "${dir}/id_ed25519" ]; then
    ssh-keygen -q -t ed25519 -N '' -C "hermes-${profile}" -f "${dir}/id_ed25519"
  fi
  printf '%s %s\n' "${sbx}" "$(cut -d' ' -f1,2 "/keys/${sbx}/ssh_host_ed25519_key.pub")" > "${dir}/known_hosts"
  # Only this profile's public key; restrict() disables forwarding and PTYs.
  printf 'restrict %s\n' "$(cut -d' ' -f1,2 "${dir}/id_ed25519.pub")" > "/keys/${sbx}/authorized_keys"
  chmod 644 "/keys/${sbx}/authorized_keys" "/keys/${sbx}/ssh_host_ed25519_key.pub"
  chmod 600 "/keys/${sbx}/ssh_host_ed25519_key" "${dir}/id_ed25519"
  chmod 644 "${dir}/id_ed25519.pub" "${dir}/known_hosts"
  chmod 700 "${dir}"
  echo "${profile} -> ${sbx}: $(ssh-keygen -lf "${dir}/id_ed25519.pub")"
done
chown -R "${OWNER}" /data/sandbox-keys
chown -R "${HOST_OWNER}" /keys
chmod 700 /data/sandbox-keys
SH

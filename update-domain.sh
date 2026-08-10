#!/usr/bin/env bash

set -uo pipefail

usage() {
  printf 'Usage: %s DOMAIN [ROOT_DIRECTORY]\n' "${0##*/}" >&2
}

if (( $# < 1 || $# > 2 )); then
  usage
  exit 2
fi

new_domain=$1
search_root=${2:-.}

if [[ -z $new_domain || $new_domain == .* || $new_domain == *. ]] ||
  (( ${#new_domain} > 253 )); then
  printf 'Error: %q is not a valid domain name.\n' "$new_domain" >&2
  exit 2
fi

IFS=. read -r -a domain_labels <<< "$new_domain"
for label in "${domain_labels[@]}"; do
  if (( ${#label} < 1 || ${#label} > 63 )) ||
    [[ ! $label =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$ ]]; then
    printf 'Error: %q is not a valid domain name.\n' "$new_domain" >&2
    exit 2
  fi
done

if [[ ! -d $search_root ]]; then
  printf 'Error: root directory does not exist: %s\n' "$search_root" >&2
  exit 2
fi

updated=0
failed=0

while IFS= read -r -d '' env_file; do
  env_directory=${env_file%/*}
  [[ $env_directory == "$env_file" ]] && env_directory=.

  if ! temporary_file=$(mktemp "$env_directory/.update-domain.XXXXXX"); then
    printf 'Failed: %s\n' "$env_file" >&2
    ((failed += 1))
    continue
  fi

  if awk -v domain="$new_domain" '
    /^[[:space:]]*(export[[:space:]]+)?DOMAIN[[:space:]]*=/ {
      sub(/=.*/, "=" domain)
      found = 1
    }
    { print }
    END {
      if (!found) {
        print "DOMAIN=" domain
      }
    }
  ' "$env_file" > "$temporary_file" &&
    chmod --reference="$env_file" "$temporary_file" &&
    mv -- "$temporary_file" "$env_file"; then
    printf 'Updated: %s\n' "$env_file"
    ((updated += 1))
  else
    printf 'Failed: %s\n' "$env_file" >&2
    rm -f -- "$temporary_file"
    ((failed += 1))
  fi
done < <(find "$search_root" -type d -name .git -prune -o -type f -name .env -print0)

printf 'Updated %d .env file(s).\n' "$updated"

if (( failed > 0 )); then
  printf 'Failed to update %d .env file(s).\n' "$failed" >&2
  exit 1
fi

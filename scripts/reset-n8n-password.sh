#!/usr/bin/env bash
# Set a new password for an n8n account (default: the owner) without email.
#
# The password is read silently from the terminal, hashed with bcrypt inside
# the n8n container (the same bcryptjs n8n uses), and written to the "user"
# table in n8n-database. It never appears in argv, the shell history, or logs.
# Workflows, credentials and the account itself are kept; existing browser
# sessions keep working until they expire.
#
# Usage: scripts/reset-n8n-password.sh [EMAIL]

set -euo pipefail

email=${1:-}

if [[ -z $email ]]; then
  email=$(docker exec n8n-database sh -c \
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT email FROM \"user\" WHERE \"roleSlug\" = '\''global:owner'\'' LIMIT 1"')
  [[ -n $email ]] || { echo "No owner account found." >&2; exit 1; }
fi

read -r -s -p "New n8n password for $email: " password; echo
read -r -s -p "Repeat it: " repeat; echo
[[ $password == "$repeat" ]] || { echo "Passwords differ." >&2; exit 1; }
# n8n's own rule: 8-64 characters with at least one number and one capital letter.
if (( ${#password} < 8 || ${#password} > 64 )) || [[ ! $password =~ [0-9] || ! $password =~ [A-Z] ]]; then
  echo "Use 8-64 characters with at least one number and one capital letter." >&2
  exit 1
fi

hash=$(printf '%s' "$password" | docker exec -i n8n sh -c \
  'cd /usr/local/lib/node_modules/n8n && node -e "
    let s = \"\"; process.stdin.on(\"data\", (d) => (s += d));
    process.stdin.on(\"end\", () => console.log(require(\"bcryptjs\").hashSync(s, 10)));"')
unset password repeat
[[ $hash == \$2* ]] || { echo "Hashing failed." >&2; exit 1; }

# psql fills :'hash' and :'email' in only from SQL it reads on stdin, so the
# hash, the email and then the statement all go through stdin.
updated=$(printf '%s\n%s\n%s\n' "$hash" "$email" \
  "UPDATE \"user\" SET password = :'hash' WHERE email = :'email' RETURNING 1;" |
  docker exec -i n8n-database sh -c '
    read -r hash; read -r email
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1 -v hash="$hash" -v email="$email"' |
  head -n 1)

if [[ $updated == 1 ]]; then
  echo "Password updated for $email. Sign in to n8n with it now."
else
  echo "No account with email $email." >&2
  exit 1
fi

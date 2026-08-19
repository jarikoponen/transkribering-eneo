#!/usr/bin/env bash
# Felsök ett Eneo-flöde mot er Eneo-instans.
#
#   ./diagnose-flow.sh <flow-id> [space-id]
#
# Läser ENEO_API_KEY (och ev. ENEO_API_KEY_2 / DEMO_SPACE_ID_2) från .env i
# repo-roten. .env är gitignorerad. Skriptet skriver ALDRIG ut nyckeln.
set -uo pipefail

cd "$(dirname "$0")"
[ -f .env ] || { echo "Saknar .env i $(pwd). Kopiera .env.example och fyll i ENEO_API_KEY."; exit 1; }
set -a; . ./.env; set +a

FLOW_ID="${1:?Ange flow-id}"
SPACE_ID="${2:-}"
BASE="${ENEO_API_BASE:?ENEO_API_BASE saknas i .env}"

KEY="${ENEO_API_KEY:?ENEO_API_KEY saknas i .env}"
# Välj nyckel för det andra spacet om space-id matchar (samma logik som backend).
if [ -n "$SPACE_ID" ] && [ "${DEMO_SPACE_ID_2:-}" = "$SPACE_ID" ] && [ -n "${ENEO_API_KEY_2:-}" ]; then
  KEY="$ENEO_API_KEY_2"
  echo "(använder ENEO_API_KEY_2)"
fi

call() {
  local label="$1" method="$2" url="$3"
  echo
  echo "=== $label"
  echo "$method $url"
  curl -s -X "$method" -H "X-API-Key: $KEY" -H 'Accept: application/json' \
    -w '\nHTTP %{http_code}\n' --max-time 30 "$url" | head -c 4000
}

call "1. published (flödesmetadata)" GET "$BASE/api/v1/flows/$FLOW_ID/published/"
call "2. run-contract (det appen kraschar på)" GET "$BASE/api/v1/flows/$FLOW_ID/run-contract/"
call "3. graph" GET "$BASE/api/v1/flows/$FLOW_ID/graph/"
[ -n "$SPACE_ID" ] && call "4. flödeslista i spacet" GET "$BASE/api/v1/flows/?space_id=$SPACE_ID&limit=50"
echo

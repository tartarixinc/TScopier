#!/usr/bin/env bash
# Run ON THE SERVER as root. Read-only probe — it starts nothing and trades
# nothing.
#
#   bash 11-check-reconnect.sh
#
# Why this exists
# ---------------
# Without the session database, a bridge that restarts forgets every session.
# The application then has to notice and sign the account in again by itself,
# and it only does that when the error it receives contains "INVALID_TOKEN" or
# "CLIENT WITH ID".
#
# If a bridge phrases it differently, reconnecting silently stops working and
# trades would fail instead. So ask each bridge directly what it says for a
# session it does not know, and compare.
#
# It matters *where* the words appear. The application reads specific fields
# (`code`, `error`, `message` and their capitalised forms) and ignores anything
# else — a page that merely mentions "INVALID_TOKEN" somewhere would not be
# recognised. This script extracts the same fields and tests only those.
#
# Run this BEFORE removing the database.
set -uo pipefail

API_KEY_FILE="${API_KEY_FILE:-/root/.mtapi_api_key}"
INTERNAL_TOKEN_FILE="${INTERNAL_TOKEN_FILE:-/root/.mtapi_internal_token}"
BASE="${BASE:-https://mtapi.tscopier.ai:9443}"
MT4_BASE="${MT4_BASE:-${BASE}/mt4}"
BOGUS="tscopier-probe-not-a-real-session"
PROOF_FILE="${PROOF_FILE:-/root/.mtapi_reconnect_ok}"
TMP="${TMPDIR:-/tmp}/tscopier-probe.$$"

if [ ! -f "$API_KEY_FILE" ]; then echo "FAIL  missing $API_KEY_FILE"; exit 1; fi
if [ ! -f "$INTERNAL_TOKEN_FILE" ]; then echo "FAIL  missing $INTERNAL_TOKEN_FILE"; exit 1; fi

command -v python3 >/dev/null 2>&1 || {
  echo "FAIL  python3 is required for a reliable check (verify.py needs it too)"
  exit 1
}

API_KEY="$(tr -d '\n' < "$API_KEY_FILE")"
INTERNAL_TOKEN="$(tr -d '\n' < "$INTERNAL_TOKEN_FILE")"

# Prints "<http status> <body>" on one line, with newlines flattened.
probe() {
  local status
  status="$(curl -k -s -o "$TMP" -w '%{http_code}' --max-time 10 \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "X-Internal-Token: ${INTERNAL_TOKEN}" \
    "$1" 2>/dev/null || true)"
  printf '%s %s' "${status:-000}" "$(tr '\n' ' ' < "$TMP" 2>/dev/null)"
}

# Reproduces EXACTLY how the application reads an error: it picks the first
# non-null of a specific set of fields, separately for the code and the message,
# then looks for the words in those two values only. Everything else in the body
# is ignored — so this must ignore it too, or we would green-light the removal on
# a response the application would never act on.
# Prints two lines: the resolved code, then the resolved message.
error_text() {
  python3 -c '
import json, sys
try:
    row = json.loads(sys.stdin.read())
except Exception:
    sys.exit(0)
if not isinstance(row, dict):
    sys.exit(0)

def first(*values):
    for v in values:
        if v is not None:
            return v
    return None

raw = first(row.get("error"), row.get("Error"))
nested = raw if isinstance(raw, dict) else {}
code = first(row.get("code"), row.get("Code"), nested.get("code"), nested.get("Code"))
if code is None and isinstance(raw, str):
    code = raw
message = first(
    row.get("message"), row.get("Message"), row.get("errorMessage"),
    nested.get("message"), nested.get("Message"),
)
print("" if code is None else str(code))
print("" if message is None else str(message))
' <<< "$1" 2>/dev/null
}

# Recognised when the application would genuinely give up and sign in again. It
# only raises an error (and therefore only recovers) when the response failed or
# carries an error code, and it only treats that as a lost session when the words
# appear in the two values resolved above.
recognised() {
  local status body fields code message upper
  status="${1%% *}"
  body="${1#* }"
  fields="$(error_text "$body")"
  code="$(printf '%s' "$fields" | sed -n 1p)"
  message="$(printf '%s' "$fields" | sed -n 2p)"
  upper="$(printf '%s %s' "$code" "$message" | tr '[:lower:]' '[:upper:]')"

  case "$upper" in
    *INVALID_TOKEN*|*CLIENT\ WITH\ ID*) : ;;
    *) return 1 ;;
  esac

  case "$status" in
    2*) [ -n "$code" ] || return 1 ;;
  esac
  return 0
}

fail=0
mt4_checked=1

echo "Probing the MT5 bridge:  $BASE"
MT5_OUT="$(probe "${BASE}/CheckConnect?id=${BOGUS}")"
echo "  status/answer: ${MT5_OUT}"
if recognised "$MT5_OUT"; then
  echo "  PASS  the application will recognise this and sign in again"
else
  echo "  FAIL  this is NOT recognised — reconnecting would stop working"
  fail=1
fi
echo

echo "Probing the MT4 bridge:  $MT4_BASE"
MT4_OUT="$(probe "${MT4_BASE}/CheckConnect?id=${BOGUS}")"
echo "  status/answer: ${MT4_OUT}"
MT4_STATUS="${MT4_OUT%% *}"
if [ "$MT4_STATUS" = "000" ] || [ "$MT4_STATUS" = "404" ] || [ "$MT4_STATUS" = "401" ] || [ "$MT4_STATUS" = "403" ]; then
  echo "  WAIT  the MT4 bridge is not reachable yet — install it (stage 4) and re-run"
  mt4_checked=0
elif recognised "$MT4_OUT"; then
  echo "  PASS  the application will recognise this and sign in again"
else
  echo "  FAIL  this is NOT recognised — reconnecting would stop working"
  fail=1
fi
echo

rm -f "$TMP"

if [ "$fail" -ne 0 ]; then
  rm -f "$PROOF_FILE"
  echo "STOP — do not remove the session database yet."
  echo "Send us the exact status and answer printed above; that wording needs"
  echo "adding to the list of messages the application treats as a lost session."
  exit 1
fi

if [ "$mt4_checked" -eq 0 ]; then
  rm -f "$PROOF_FILE"
  echo "MT5 IS SAFE TO RUN WITHOUT THE SESSION DATABASE."
  echo "MT4 has NOT been checked yet — install it (stage 4) and run this again"
  echo "before removing the database. (Nothing has been recorded as proven.)"
  exit 0
fi

# Record that both bridges were proven, so the removal step can insist on it.
date -u +'%Y-%m-%dT%H:%M:%SZ' > "$PROOF_FILE" 2>/dev/null || true
echo "BOTH BRIDGES ARE SAFE TO RUN WITHOUT THE SESSION DATABASE."
echo "Recorded in $PROOF_FILE. Next:"
echo "    bash 10-remove-session-db.sh"

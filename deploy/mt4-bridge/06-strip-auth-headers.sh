#!/usr/bin/env bash
# Stage 6 — run ON THE SERVER as root.
#
# Strips the caller's credentials (Authorization: Bearer <API key> and
# X-Internal-Token) at nginx before it proxies to the containers. The MT4
# bridge (mt4rest) appends the request headers it received to its own
# "client not found" body, so without the strip our two perimeter secrets are
# echoed back to the caller — into the worker log, into trade_execution_logs,
# and, through the mtapi-broker edge function, into a customer's browser.
#
# nginx has already authenticated the request at this point (the auth maps read
# the incoming $http_authorization / $http_x_internal_token, which
# proxy_set_header cannot disturb), and neither container is configured with
# either secret, so forwarding them only feeds the echo.
#
# Applied ONE LOCATION AT A TIME because each location declares its own
# proxy_set_header set, and because we cannot prove from outside that the
# vendor container has no use for the headers — each stage is gated on the
# bridge still answering, and rolled back automatically if it does not.
#
# This script edits /etc/nginx/conf.d; it does NOT ship the files there. On a
# fresh machine the public config arrives via 01-copy-files.sh and the tunnel
# config via the WireGuard setup step (deploy/wireguard/), and 05-nginx.sh will
# not re-copy the public file once the MT4 path is present.
#
# Usage:
#   bash 06-strip-auth-headers.sh apply canary   # stage 1: /health + /mt4/Ping
#   bash 06-strip-auth-headers.sh apply mt4      # stage 2: /mt4/
#   bash 06-strip-auth-headers.sh apply mt5      # stage 3: /
#   bash 06-strip-auth-headers.sh apply tunnel   # stage 4: WireGuard tunnel conf
#   bash 06-strip-auth-headers.sh check          # ongoing probe, changes nothing
#
# From your own machine, between stages:
#   python3 deploy/mt4-bridge/verify.py quick
#   python3 deploy/mt4-bridge/verify.py signin
set -euo pipefail

SITE=/etc/nginx/conf.d/mtapi-tscopier.conf
TUNNEL=/etc/nginx/conf.d/mtapi-tscopier-tunnel.conf
BASE="https://mtapi.tscopier.ai:9443"
# WireGuard listener, plain HTTP inside the tunnel. Override if wg0 uses a
# different address.
TUNNEL_BASE="${TUNNEL_BASE:-http://10.66.0.1:9443}"
BOGUS_SESSION="tscopier-strip-probe-not-a-real-session"

# The `listen` line of the server block the locations live in, so an edit can
# only land in that block: `location / {` also appears in the port-80 ACME block.
PUB_ANCHOR="    listen 9443 ssl http2;"
TUN_ANCHOR="    listen 10.66.0.1:9443;"

# Every (file|anchor|location) stage 6 owns — used by the structural probe.
STRIP_TARGETS=(
  "$SITE|$PUB_ANCHOR|    location = /health {"
  "$SITE|$PUB_ANCHOR|    location = /mt4/Ping {"
  "$SITE|$PUB_ANCHOR|    location /mt4/ {"
  "$SITE|$PUB_ANCHOR|    location / {"
  "$TUNNEL|$TUN_ANCHOR|    location = /health {"
  "$TUNNEL|$TUN_ANCHOR|    location / {"
)

ACTION="${1:-}"
STAGE="${2:-}"

# --- credentials (read, never printed) ---------------------------------------
API_KEY=""
INTERNAL_TOKEN=""
if [ -r /root/.mtapi_api_key ]; then API_KEY="$(cat /root/.mtapi_api_key)"; fi
if [ -r /root/.mtapi_internal_token ]; then INTERNAL_TOKEN="$(cat /root/.mtapi_internal_token)"; fi

# Fail closed: the echo probe is the whole point of this script, so a run that
# cannot perform it must not report success.
creds_available() { [ -n "$API_KEY" ] && [ -n "$INTERNAL_TOKEN" ]; }

http_code() {
  local c
  c="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$1" 2>/dev/null || true)"
  printf '%s' "${c:-000}"
}

# body of an authenticated GET; printed to stdout (caller decides what to show)
auth_body() {
  curl -s --max-time 15 \
    -H "Authorization: Bearer ${API_KEY}" \
    -H "X-Internal-Token: ${INTERNAL_TOKEN}" \
    "$1" 2>/dev/null || true
}

fail=0
say()  { printf '%s\n' "$*"; }
ok()   { printf 'PASS  %s\n' "$*"; }
bad()  { printf 'FAIL  %s\n' "$*"; fail=1; }

# --- edit and interrupt safety -----------------------------------------------
# The config is replaced by atomic rename, and a backup taken for a stage is
# restored if the script dies mid-flight, so an interrupted run can never leave
# a truncated or half-edited live config behind.
TMP_OUT=""
PENDING_FILE=""
PENDING_BACKUP=""

# Replace $1 with $2 by atomic rename, so an interrupted restore cannot leave a
# half-written live config. Returns 0 only when the rename succeeded.
restore_atomic() {  # $1 target, $2 backup
  local tmp
  tmp="$(mktemp "$1.XXXXXX")" || return 1
  if ! cp -a "$2" "$tmp"; then rm -f "$tmp"; return 1; fi
  chmod --reference="$1" "$tmp" 2>/dev/null || true
  chown --reference="$1" "$tmp" 2>/dev/null || true
  if ! mv -f "$tmp" "$1"; then rm -f "$tmp"; return 1; fi
  return 0
}

cleanup() {
  if [ -n "$TMP_OUT" ]; then rm -f "$TMP_OUT"; fi
  if [ -n "$PENDING_BACKUP" ] && [ -f "$PENDING_BACKUP" ]; then
    if restore_atomic "$PENDING_FILE" "$PENDING_BACKUP"; then
      if nginx -t >/dev/null 2>&1; then systemctl reload nginx >/dev/null 2>&1 || true; fi
      printf 'Interrupted — restored %s from %s\n' "$PENDING_FILE" "$PENDING_BACKUP" >&2
    else
      printf 'Interrupted — COULD NOT restore %s; backup is %s\n' "$PENDING_FILE" "$PENDING_BACKUP" >&2
    fi
  fi
}

# --- finding the right place -------------------------------------------------
# Prints 1 if BOTH directives are present anywhere in that location block, else
# 0. Scanning the whole block (not only the next line) means a config installed
# from the repo template — which places the lines at the end of the block — is
# recognised as already applied instead of being patched a second time. Braces
# inside quotes or comments are ignored, so they cannot mislead the scan. Both
# directives must be present: a half-edit that only wrote Authorization must not
# be mistaken for a finished strip.
strip_state() {  # $1 file, $2 server anchor, $3 location line -> prints "AB"
  # A = 1 if Authorization is present in the block, B = 1 for X-Internal-Token.
  # Scanning the whole block (not only the next line) means a config installed
  # from the repo template — which places the lines at the end of the block — is
  # recognised as already applied instead of being patched a second time. Braces
  # inside quotes or comments are ignored, so they cannot mislead the scan.
  local out
  out="$(awk -v anchor="$2" -v loc="$3" '
      function brace_delta(s,   i, n, ch, inq, insq, d) {
        d = 0; inq = 0; insq = 0; n = length(s)
        for (i = 1; i <= n; i++) {
          ch = substr(s, i, 1)
          if (inq) {
            if (ch == "\\") { i++; continue }
            if (ch == "\"") inq = 0
            continue
          }
          if (insq) { if (ch == sq) insq = 0; continue }
          if (ch == "\"") { inq = 1; continue }
          if (ch == sq) { insq = 1; continue }
          if (ch == "#") break
          if (ch == "{") d++
          else if (ch == "}") d--
        }
        return d
      }
      BEGIN { sq = sprintf("%c", 39) }
      { line = $0 }
      !done && line == anchor { inscope = 1; next }
      inscope && line ~ /^[ \t]*server[ \t]*\{/ { inscope = 0; next }
      !done && inscope && line == loc {
        fa = 0; ft = 0
        depth = 1
        while ((getline nxt) > 0) {
          if (nxt !~ /^[ \t]*#/) {
            if (nxt ~ /proxy_set_header[ \t]+Authorization/) fa = 1
            if (nxt ~ /proxy_set_header[ \t]+X-Internal-Token/) ft = 1
          }
          depth += brace_delta(nxt)
          if (depth <= 0) break
        }
        print (fa ? 1 : 0) "" (ft ? 1 : 0)
        done = 1
        exit
      }
    ' "$1" 2>/dev/null || true)"
  case "$out" in
    11|10|01|00) printf '%s' "$out" ;;
    *)           printf '00' ;;
  esac
}

# Both directives present, i.e. the location is fully stripped.
already_there() { [ "$(strip_state "$@")" = "11" ]; }

# Insert whichever of the two lines is missing, directly after the location's
# opening line. Order within a block is irrelevant for proxy_set_header. Returns
# 0 only after verifying both directives landed, so no path can report success
# without inserting.
add_strip() {  # $1 file, $2 server anchor, $3 location line
  local file="$1" anchor="$2" loc="$3" tmp state need_auth need_tok
  if [ ! -f "$file" ]; then
    say "FAIL  $file does not exist"; return 1
  fi
  if ! grep -qxF "$loc" "$file"; then
    say "FAIL  location line not found in $file:  $loc"
    return 1
  fi
  if ! grep -qxF "$anchor" "$file"; then
    say "FAIL  server anchor not found in $file:  $anchor"
    return 1
  fi
  state="$(strip_state "$file" "$anchor" "$loc")"
  if [ "$state" = "11" ]; then
    say "Status : already stripped —  $loc"
    return 0
  fi
  need_auth=$(( 1 - ${state:0:1} ))
  need_tok=$(( 1 - ${state:1:1} ))
  # Temp file lives beside the target so the write-back is an atomic rename.
  tmp="$(mktemp "${file}.XXXXXX")"
  TMP_OUT="$tmp"
  if ! awk -v anchor="$anchor" -v loc="$loc" -v na="$need_auth" -v nt="$need_tok" '
      { line = $0 }
      !done && line == anchor { inscope = 1; print; next }
      inscope && line ~ /^[ \t]*server[ \t]*\{/ { inscope = 0; print; next }
      !done && inscope && line == loc {
        # Read-ahead must succeed: a location line must be followed by at least
        # one line. Failing here discards the temp file rather than publishing a
        # config that looks edited but is not.
        if ((getline nxt) <= 0) { done = 1; exit 3 }
        print
        if (na) print "        proxy_set_header Authorization \"\";"
        if (nt) print "        proxy_set_header X-Internal-Token \"\";"
        print nxt
        done = 1
        next
      }
      { print }
      END { if (!done) exit 3 }
    ' "$file" > "$tmp"; then
    rm -f "$tmp"; TMP_OUT=""
    say "FAIL  could not place $loc inside the server block of $file"
    return 1
  fi
  # Keep the live file's ownership and mode across the rename.
  chmod --reference="$file" "$tmp" 2>/dev/null || true
  chown --reference="$file" "$tmp" 2>/dev/null || true
  if ! mv -f "$tmp" "$file"; then
    rm -f "$tmp"; TMP_OUT=""
    say "FAIL  could not replace $file"
    return 1
  fi
  TMP_OUT=""
  if [ "$(strip_state "$file" "$anchor" "$loc")" != "11" ]; then
    say "FAIL  the strip did not land in:  $loc"
    return 1
  fi
  return 0
}

# Reload only after nginx -t passes. Returns non-zero on any failure; the caller
# restores the backup.
deploy() {
  if ! nginx -t; then
    say "FAIL  nginx rejected the config"
    return 1
  fi
  if ! systemctl reload nginx; then
    say "FAIL  systemctl reload nginx failed"
    return 1
  fi
  # Graceful reload: old workers keep serving until they drain, so a request
  # right after can still be answered by the previous config. Let it settle so
  # the checks judge the new config (same reasoning as 05-nginx.sh).
  sleep 3
  return 0
}

rollback() {  # $1 file, $2 backup
  if ! restore_atomic "$1" "$2"; then
    say "WARN  could not restore the backup $2"
    return 1
  fi
  PENDING_FILE=""; PENDING_BACKUP=""
  if ! nginx -t; then say "WARN  nginx -t failed after restoring the backup"; return 1; fi
  if ! systemctl reload nginx; then say "WARN  reload after rollback failed"; return 1; fi
  sleep 2
  return 0
}

# --- gates -------------------------------------------------------------------
gate_common() {
  local c
  c="$(http_code "$BASE/health")"
  [ "$c" = 200 ] && ok "/health -> 200" || bad "/health -> $c"

  c="$(http_code "$BASE/mt4/Ping")"
  [ "$c" = 200 ] && ok "/mt4/Ping -> 200" || bad "/mt4/Ping -> $c"

  c="$(http_code "$BASE/mt4/AccountSummary")"
  case "$c" in
    401|403) ok "/mt4/AccountSummary without credentials -> $c (blocked)" ;;
    *)       bad "/mt4/AccountSummary without credentials -> $c (must be 401 or 403)" ;;
  esac
}

# The point of the whole exercise. Never prints the body — it would contain the
# live secrets if the strip is not in effect. Only meaningful against MT4
# (mt4rest): it is the only backend that echoes the request headers.
gate_echo() {  # $1 = label, $2 = full URL
  local label="$1" url="$2" body
  if ! creds_available; then
    bad "$label echo gate could not run — credentials not readable (refusing to pass)"
    return 0
  fi
  body="$(auth_body "$url")"
  # The container must actually have processed the request: otherwise a silent
  # auth break would look like "no secrets echoed". Case-insensitive to match
  # what isSessionGone() in the worker accepts.
  if ! printf '%s' "$body" | grep -qi 'Client with id'; then
    bad "$label did not reach the bridge (no 'Client with id' in the reply) — the strip likely broke it"
    return 0
  fi
  if printf '%s' "$body" | grep -Eqi 'x-internal-token[[:space:]]*:|authorization[[:space:]]*:[[:space:]]*bearer'; then
    bad "$label still echoes credentials — this location is not stripped yet"
  else
    ok "$label reaches the bridge and echoes no credentials"
  fi
}

# The WireGuard listener is a separate server block; the public probes never
# touch it. 000 means nothing is listening, and with no listener there is no
# leak path — say so rather than passing silently.
gate_tunnel() {
  local c
  c="$(http_code "${TUNNEL_BASE}/health")"
  if [ "$c" = "000" ]; then
    say "SKIP  tunnel probe — ${TUNNEL_BASE} not reachable (wg0 down: no listener, no leak path)"
    return 0
  fi
  [ "$c" = 200 ] && ok "tunnel /health -> 200" || bad "tunnel /health -> $c"
}

# Directive presence for every location stage 6 owns. This is the check that
# applies to ALL locations; the runtime echo probe below only covers MT4.
structural_check() {
  local t f a l
  for t in "${STRIP_TARGETS[@]}"; do
    IFS='|' read -r f a l <<<"$t"
    if [ ! -f "$f" ]; then
      say "SKIP  $f not installed —  $l"
      continue
    fi
    if already_there "$f" "$a" "$l"; then
      ok "stripped:  $(basename "$f")  $l"
    else
      bad "NOT stripped:  $(basename "$f")  $l"
    fi
  done
}

# MT5 (mtapi_backend) does not echo the request headers, so an echo probe on the
# mt5/tunnel locations would pass whether or not the strip is present. Say that
# plainly instead of reporting a pass the probe cannot justify.
note_no_echo() {  # $1 = what the location targets
  say "NOTE  $1 does not echo request headers, so an echo probe cannot prove this"
  say "      strip. Directive presence is verified structurally above; the runtime"
  say "      echo is MT4-only."
}

# --- modes -------------------------------------------------------------------
cmd_check() {
  say "--- ongoing probe (no changes made) ---"
  if ! creds_available; then
    say "FAIL  credentials not readable — run as root (it reads /root/.mtapi_api_key"
    say "      and /root/.mtapi_internal_token), so the echo probe can actually run."
    exit 1
  fi
  gate_common
  gate_tunnel
  echo
  say "--- structural: directive present in each target location ---"
  structural_check
  echo
  say "--- runtime echo (the security-relevant check) ---"
  gate_echo "MT4" "$BASE/mt4/CheckConnect?id=${BOGUS_SESSION}"
  echo
  if [ "$fail" -eq 0 ]; then say "ALL CHECKS PASSED"; else say "SOME CHECKS FAILED"; exit 1; fi
}

apply_stage() {
  local stage="$1" file anchor locs=() backup need_echo=0

  case "$stage" in
    canary)
      file="$SITE"; anchor="$PUB_ANCHOR"
      locs=("    location = /health {" "    location = /mt4/Ping {")
      need_echo=0
      ;;
    mt4)
      file="$SITE"; anchor="$PUB_ANCHOR"
      locs=("    location /mt4/ {")
      need_echo=1
      ;;
    mt5)
      file="$SITE"; anchor="$PUB_ANCHOR"
      locs=("    location / {")
      need_echo=0
      ;;
    tunnel)
      file="$TUNNEL"; anchor="$TUN_ANCHOR"
      locs=("    location = /health {" "    location / {")
      need_echo=0
      ;;
    *)
      say "unknown stage: $stage"
      say "usage: $0 apply {canary|mt4|mt5|tunnel}   or   $0 check"
      exit 2
      ;;
  esac

  if [ "$(id -u)" -ne 0 ]; then
    say "FAIL  run this on the VPS as root (it edits /etc/nginx/conf.d)"
    exit 1
  fi

  # The MT4 stage is the only one whose echo gate is meaningful, so it is the
  # only one that requires the credentials. Refuse rather than run it ungated.
  if [ "$need_echo" -eq 1 ] && ! creds_available; then
    say "FAIL  credentials not readable, so stage '$stage' cannot be gated."
    say "      Expected /root/.mtapi_api_key and /root/.mtapi_internal_token."
    exit 1
  fi

  local already=1
  for loc in "${locs[@]}"; do
    already_there "$file" "$anchor" "$loc" || already=0
  done
  if [ "$already" -eq 1 ]; then
    say "Status : stage '$stage' is already applied — nothing to do"
  else
    backup="${file}.bak-$(date +%Y%m%d-%H%M%S)"
    cp -a "$file" "$backup"
    PENDING_FILE="$file"; PENDING_BACKUP="$backup"
    say "Backup : $backup"

    for loc in "${locs[@]}"; do
      add_strip "$file" "$anchor" "$loc" || { rollback "$file" "$backup" || true; exit 1; }
    done

    # Post-condition across the whole stage: a stage must never report success
    # with a directive missing (canary, mt5 and tunnel have no echo gate).
    for loc in "${locs[@]}"; do
      if ! already_there "$file" "$anchor" "$loc"; then
        say "FAIL  post-condition: strip missing from  $loc"
        rollback "$file" "$backup" || true
        exit 1
      fi
    done

    if ! deploy "$file" "$backup"; then
      say "Restoring the previous config."
      rollback "$file" "$backup" || true
      exit 1
    fi
    say "PASS  nginx accepted the config and reloaded"
  fi

  echo
  say "--- checks ---"
  gate_common
  if [ "$stage" = "tunnel" ]; then gate_tunnel; fi
  if [ "$stage" = "mt4" ]; then
    gate_echo "MT4" "$BASE/mt4/CheckConnect?id=${BOGUS_SESSION}"
  elif [ "$stage" = "mt5" ]; then
    note_no_echo "public / → MT5 (mtapi_backend)"
  elif [ "$stage" = "tunnel" ]; then
    note_no_echo "tunnel / → MT5 (mtapi_backend)"
  fi

  echo
  if [ "$fail" -eq 0 ]; then
    PENDING_FILE=""; PENDING_BACKUP=""
    say "STAGE '$stage' PASSED"
  else
    if [ "${already:-1}" -eq 0 ] && [ -n "${backup:-}" ]; then
      say "Rolling back stage '$stage' — the previous config is live again."
      rollback "$file" "$backup" || true
    fi
    say "STAGE '$stage' FAILED"
    exit 1
  fi
}

# Guarded so tests can `source` this file and exercise add_strip / already_there
# without running a stage. Sourcing also applies `set -euo pipefail` to the
# caller, so a test harness should save and restore `$-`.
if [ "${BASH_SOURCE[0]:-}" = "${0}" ]; then
  trap cleanup EXIT
  case "$ACTION" in
    apply) apply_stage "$STAGE" ;;
    check) cmd_check ;;
    *)
      say "usage: $0 apply {canary|mt4|mt5|tunnel}   or   $0 check"
      exit 2
      ;;
  esac
fi

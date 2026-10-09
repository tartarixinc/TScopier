#!/usr/bin/env bash
# Self-test for redact.awk — no Docker required.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AWK="${DIR}/redact.awk"
fail=0

check() {
  local name="$1" input="$2" expect_not="$3" expect_yes="${4:-}"
  local out
  out="$(printf '%s\n' "$input" | awk -f "$AWK")"
  if printf '%s' "$out" | grep -qF "$expect_not"; then
    echo "FAIL ${name}: still contains [${expect_not}]"
    echo "  got: ${out}"
    fail=1
    return
  fi
  if [ -n "$expect_yes" ] && ! printf '%s' "$out" | grep -qF "$expect_yes"; then
    echo "FAIL ${name}: missing expected [${expect_yes}]"
    echo "  got: ${out}"
    fail=1
    return
  fi
  echo "OK   ${name}"
}

# Real incident line (password replaced with marker in input only)
check "wrn-tuple" \
  "[08:18:40 WRN] ('476205231' 'Hunter2-secret!' '96.0.46.31' '443' '' '5c6d8eb6-09bb-41b5-b260-73498b725661')  <Symbol not found: XAUUSD>" \
  "Hunter2-secret!" \
  "[REDACTED]"

check "url-password" \
  "GET /ConnectEx?login=1&password=Sup3rSecret&server=Exness HTTP/1.1" \
  "Sup3rSecret" \
  "password=[REDACTED]"

check "json-password" \
  '{"password":"JsonSecret123","login":"1"}' \
  "JsonSecret123" \
  "[REDACTED]"

check "multi-tuple" \
  "first ('111' 'SecretA' '1.2.3.4') second ('222' 'SecretB' '5.6.7.8')" \
  "SecretA" \
  "[REDACTED]"

check "multi-tuple-second" \
  "first ('111' 'SecretA' '1.2.3.4') second ('222' 'SecretB' '5.6.7.8')" \
  "SecretB" \
  "[REDACTED]"

check "login-preserved" \
  "[08:18:40 WRN] ('476205231' 'Hunter2-secret!' '96.0.46.31' '443')" \
  "Hunter2-secret!" \
  "476205231"

# Clean lines must pass through unchanged (no false-positive redaction)
check "plain-line-preserved" \
  "[01:00:00 INF] Request finished HTTP/1.1 GET /AccountSummary?id=abc - - - 200" \
  "[REDACTED]" \
  "AccountSummary"

# --- credentials echoed in headers (observed 2026-09-29 on the MT4 service) ---
# Shape mirrors the real error line: headers joined by "___", values after the
# header name. Fake values only — never paste real credentials into a test.
HEADER_DUMP="[07:53:17 ERR] Client with id = probe not found. Headers = Accept : */*___Host : mtapi.tscopier.ai___User-Agent : curl/8.5.0___Authorization : Bearer FAKEAPIKEY0000000000000000000000000000000000000000000000000000___X-Real-IP : 13.140.44.122___x-internal-token : FAKEINTERNALTOKEN000000000000000000000000000000000000000000000___"

check "header-dump-api-key" \
  "$HEADER_DUMP" \
  "FAKEAPIKEY0000000000000000000000000000000000000000000000000000" \
  "[REDACTED]"

check "header-dump-internal-token" \
  "$HEADER_DUMP" \
  "FAKEINTERNALTOKEN000000000000000000000000000000000000000000000" \
  "[REDACTED]"

check "header-dump-keeps-bearer-word" \
  "$HEADER_DUMP" \
  "FAKEINTERNALTOKEN000000000000000000000000000000000000000000000" \
  "Bearer [REDACTED]"

# The header AFTER the redacted one must survive: if the bearer rule swallowed
# it, the internal-token rule would never see its own header name and would
# leave that token in the clear.
check "header-dump-next-header-kept" \
  "$HEADER_DUMP" \
  "FAKEAPIKEY0000000000000000000000000000000000000000000000000000" \
  "___X-Real-IP : 13.140.44.122"

# Other ways the same credential can be written down.
check "bearer-eq-form" \
  "[01:00:00 INF] bearer=FAKEAPIKEY0000000000000000000000000000000000000000000000000000" \
  "FAKEAPIKEY0000000000000000000000000000000000000000000000000000" \
  "bearer=[REDACTED]"

check "bearer-colon-form" \
  "[01:00:00 INF] Authorization: Bearer: FAKEAPIKEY0000000000000000000000000000000000000000000000000000" \
  "FAKEAPIKEY0000000000000000000000000000000000000000000000000000" \
  "[REDACTED]"

# The gone-session error code must survive — it is what triggers reconnection.
check "error-code-preserved" \
  '[07:53:17 INF] {"message":"Client with id = probe not found","code":"INVALID_TOKEN"}' \
  "[REDACTED]" \
  "INVALID_TOKEN"

# Ordinary prose mentioning "bearer" must not be mangled.
check "prose-bearer-preserved" \
  "[01:00:00 INF] the bearer of good news arrived" \
  "[REDACTED]" \
  "bearer of good news"

# ...including a long ordinary word that is not credential-shaped.
check "prose-long-word-preserved" \
  "[01:00:00 INF] the Bearer authentication scheme failed" \
  "[REDACTED]" \
  "Bearer authentication scheme"

# Quoted values must be redacted too (JSON-shaped logs and header echoes).
check "quoted-bearer" \
  '[01:00:00 INF] Authorization: Bearer "FAKEAPIKEY0000000000000000000000000000000000000000000000000000"' \
  "FAKEAPIKEY0000000000000000000000000000000000000000000000000000" \
  "Bearer \"[REDACTED]\""

check "quoted-internal-token-json" \
  '{"x-internal-token":"FAKEINTERNALTOKEN000000000000000000000000000000000000000000000"}' \
  "FAKEINTERNALTOKEN000000000000000000000000000000000000000000000" \
  "[REDACTED]"

# HTTP auth schemes are case-insensitive.
check "bearer-uppercase" \
  "[01:00:00 INF] BEARER FAKEAPIKEY0000000000000000000000000000000000000000000000000000" \
  "FAKEAPIKEY0000000000000000000000000000000000000000000000000000" \
  "[REDACTED]"

# Punctuation after the credential must survive — only the secret is replaced.
check "bearer-trailing-punctuation" \
  "[01:00:00 INF] Authorization: Bearer FAKEAPIKEY0000000000000000000000000000000000000000000000000000, retrying" \
  "FAKEAPIKEY0000000000000000000000000000000000000000000000000000" \
  "[REDACTED], retrying"

if [ "$fail" -ne 0 ]; then
  echo "redact.awk tests FAILED"
  exit 1
fi
echo "All redact.awk tests passed"

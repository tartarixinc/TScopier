# Redact broker passwords and API credentials from MTAPI (timurila/mt4rest,
# timurila/mt5rest) log lines.
# One line in, one line out. Compatible with gawk, mawk, busybox awk.
#
# Patterns:
#   1) ('login' 'PASSWORD' 'ip' ...)  — 2nd single-quoted field is the password
#   2) password=... / passwd=... / pwd=... in query or form values
#   3) "password":"..." JSON field
#   4) password: '...' / password = "..." config-style
#   5) Bearer <token>  — the API key, e.g. "Authorization : Bearer abc123..."
#   6) x-internal-token : <value>  — the internal token, any letter case
#
# Patterns 5 and 6 exist because the MT4 service echoes request headers back in
# its error messages (observed 2026-09-29). It does not currently write those
# messages to its log, but if that ever changes these keep the credentials off
# disk — the same failure shape as the 2026-09-23 password-in-logs incident.

function redact_tuple(s,    out, pos, start, matchlen, head, rest) {
  out = ""
  pos = 1
  while (1) {
    if (!match(substr(s, pos), /\('[^']+'[ \t]+'/)) {
      out = out substr(s, pos)
      return out
    }
    start = pos + RSTART - 1
    matchlen = RLENGTH
    # head = ('login' '   (ends at opening quote of password field)
    head = substr(s, start, matchlen)
    rest = substr(s, start + matchlen)
    out = out substr(s, pos, start - pos) head "[REDACTED]'"
    # Skip password field (and closing quote if present); continue scanning
    if (match(rest, /^[^']+'/)) {
      pos = start + matchlen + RLENGTH
    } else if (match(rest, /^[^']+/)) {
      pos = start + matchlen + RLENGTH
    } else {
      pos = start + matchlen
    }
    if (pos <= start) pos = start + 1
  }
}

function redact_key_eq(s,    out, done, lower, start, len, seg, head) {
  out = ""
  lower = tolower(s)
  done = 0
  while (!done && match(lower, /(password|passwd|pwd)=[^&" \t]*/)) {
    start = RSTART
    len = RLENGTH
    seg = substr(s, start, len)
    if (match(seg, /=/)) {
      head = substr(seg, 1, RSTART)
      out = out substr(s, 1, start - 1) head "[REDACTED]"
      s = substr(s, start + len)
      lower = tolower(s)
    } else {
      done = 1
    }
    if (length(out) > 10000) done = 1
  }
  return out s
}

function redact_json(s,    out, start, len, seg, head) {
  out = ""
  while (match(s, /"[Pp]assword"[ \t]*:[ \t]*"[^"]*"/)) {
    start = RSTART
    len = RLENGTH
    seg = substr(s, start, len)
    if (match(seg, /"[Pp]assword"[ \t]*:[ \t]*"/)) {
      head = substr(seg, 1, RSTART + RLENGTH - 1)
      out = out substr(s, 1, start - 1) head "[REDACTED]\""
      s = substr(s, start + len)
    } else {
      break
    }
  }
  return out s
}

function redact_cfg(s,    out, lower, start, len, seg, qch, rest) {
  out = ""
  lower = tolower(s)
  while (match(lower, /password[ \t]*[:=][ \t]*['"]/)) {
    start = RSTART
    len = RLENGTH
    seg = substr(s, start, len)
    qch = substr(seg, length(seg), 1)
    rest = substr(s, start + len)
    if (match(rest, /^[^'"]*['"]/)) {
      out = out substr(s, 1, start - 1) seg "[REDACTED]" qch
      s = substr(s, start + len + RLENGTH)
      lower = tolower(s)
    } else {
      out = out substr(s, 1, start - 1) seg "[REDACTED]" qch
      s = ""
      lower = ""
      break
    }
  }
  return out s
}

# Is this text shaped like a credential rather than an ordinary word?
# Long, or mid-length and containing a digit. "authentication" (14 letters, no
# digit) is not; a 16-character hex token is.
function looks_like_secret(t,    digits) {
  if (length(t) < 12) return 0
  if (length(t) >= 20) return 1
  return (t ~ /[0-9]/)
}

# The MT4 service joins echoed headers with "___". Split the credential from
# that separator, but only when the leading part really looks like a credential
# — otherwise a credential that itself contains underscores would be cut short
# and half of it left on disk. The separator ends up in SPLIT_TAIL.
function split_dump(tok,    pos, head) {
  SPLIT_TAIL = ""
  pos = index(tok, "___")
  if (pos > 1) {
    head = substr(tok, 1, pos - 1)
    if (looks_like_secret(head)) {
      SPLIT_TAIL = substr(tok, pos)
      return head
    }
  }
  return tok
}

# 5) Bearer tokens: "Bearer <key>", "Bearer: <key>", "bearer=<key>" or the same
# with the value quoted. The scheme name is case-insensitive, as HTTP requires.
# The word "Bearer" survives; only the credential after it is replaced.
function redact_bearer(s,    out, lower, start, len, seg, rest, sep, tok, q, core, tail) {
  out = ""
  lower = tolower(s)
  while (match(lower, /bearer[ \t]*("?[ \t]*[:=][ \t]*|[ \t]*)("[A-Za-z0-9._~+\/=-]+"|[A-Za-z0-9._~+\/=-]+)/)) {
    start = RSTART
    len = RLENGTH
    seg = substr(s, start, len)
    rest = substr(seg, 7)
    sep = ""
    tok = rest
    if (match(rest, /^[ \t]*("?[ \t]*[:=][ \t]*|[ \t]*)/)) {
      sep = substr(rest, 1, RLENGTH)
      tok = substr(rest, RLENGTH + 1)
    }
    q = ""
    if (substr(tok, 1, 1) == "\"") {
      q = "\""
      tok = substr(tok, 2)
      sub(/"$/, "", tok)
    }
    core = split_dump(tok)
    tail = SPLIT_TAIL
    if (looks_like_secret(core)) {
      out = out substr(s, 1, start - 1) substr(seg, 1, 6) sep q "[REDACTED]" q tail
    } else {
      # not credential-shaped — leave the line alone rather than mangle prose
      out = out substr(s, 1, start + len - 1)
    }
    s = substr(s, start + len)
    lower = tolower(s)
  }
  return out s
}

# 6) Internal token headers: "x-internal-token : <value>", any letter case,
# with an optional separator and an optional quoted value.
function redact_internal_token(s,    out, lower, start, len, seg, rest, sep, tok, q, core, tail) {
  out = ""
  lower = tolower(s)
  while (match(lower, /x-internal-token[ \t]*("?[ \t]*[:=][ \t]*|[ \t]*)("[A-Za-z0-9._~+\/=-]+"|[A-Za-z0-9._~+\/=-]+)/)) {
    start = RSTART
    len = RLENGTH
    seg = substr(s, start, len)
    rest = substr(seg, 17)
    sep = ""
    tok = rest
    if (match(rest, /^[ \t]*("?[ \t]*[:=][ \t]*|[ \t]*)/)) {
      sep = substr(rest, 1, RLENGTH)
      tok = substr(rest, RLENGTH + 1)
    }
    q = ""
    if (substr(tok, 1, 1) == "\"") {
      q = "\""
      tok = substr(tok, 2)
      sub(/"$/, "", tok)
    }
    core = split_dump(tok)
    tail = SPLIT_TAIL
    if (looks_like_secret(core)) {
      out = out substr(s, 1, start - 1) substr(seg, 1, 16) sep q "[REDACTED]" q tail
    } else {
      out = out substr(s, 1, start + len - 1)
    }
    s = substr(s, start + len)
    lower = tolower(s)
  }
  return out s
}

{
  line = $0
  line = redact_tuple(line)
  line = redact_key_eq(line)
  line = redact_json(line)
  line = redact_cfg(line)
  line = redact_bearer(line)
  line = redact_internal_token(line)
  print line
  # Pipe to Docker: without fflush, gawk/mawk block-buffer and docker logs lag
  fflush()
}

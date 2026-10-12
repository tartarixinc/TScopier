import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts"
import { redactBridgeSecrets } from "./mtapiRedaction.ts"
import { MtapiApiError } from "./mtapiClient.ts"

// Shape captured live from the MT4 bridge on 2026-10-11 (credential values
// replaced with the same placeholders `deploy/mtapi-log-redactor/test.sh` uses).
const MT4_DUMP =
  "Client with id = tscopier-probe-not-a-real-session not found. " +
  "Please use /Connect to create new token. Headers = Accept : */*___" +
  "Host : mtapi.tscopier.ai___User-Agent : curl/8.5.0___" +
  "Authorization : Bearer FAKEAPIKEY0000000000000000000000000000000000000000000000000000___" +
  "X-Real-IP : 13.140.44.122___X-Forwarded-For : 13.140.44.122___" +
  "X-Forwarded-Proto : https___" +
  "x-internal-token : FAKEINTERNALTOKEN0000000000000000000000000000000000000000000000000___"

const MT5_MESSAGE = "Client with id = tscopier-probe-not-a-real-session not found (:0)"

Deno.test("redactBridgeSecrets strips both credentials from the MT4 header dump", () => {
  const out = redactBridgeSecrets(MT4_DUMP)
  assertStringIncludes(out, "Authorization : Bearer [REDACTED]")
  assertStringIncludes(out, "x-internal-token : [REDACTED]")
  assert(!out.includes("FAKEAPIKEY"), "the API key must not survive")
  assert(!out.includes("FAKEINTERNALTOKEN"), "the internal token must not survive")
})

Deno.test("redactBridgeSecrets keeps the session-recovery prefix intact", () => {
  const out = redactBridgeSecrets(MT4_DUMP)
  // `isSessionGone` and `brokerConnectError` both match on this phrase; if it
  // were redacted, reconnecting after a bridge restart would stop working.
  assertStringIncludes(out, "Client with id = tscopier-probe-not-a-real-session not found")
  assertStringIncludes(out, "Please use /Connect to create new token")
  assertStringIncludes(out, "Headers = Accept : */*")
  assertStringIncludes(out, "X-Real-IP : 13.140.44.122")
})

Deno.test("redactBridgeSecrets leaves the clean MT5 message untouched", () => {
  assertEquals(redactBridgeSecrets(MT5_MESSAGE), MT5_MESSAGE)
})

Deno.test("redactBridgeSecrets returns empty and unrelated strings unchanged", () => {
  assertEquals(redactBridgeSecrets(""), "")
  assertEquals(redactBridgeSecrets("no credentials here"), "no credentials here")
})

Deno.test("redactBridgeSecrets does not mangle prose that mentions a scheme", () => {
  // `looks_like_secret` mirrors redact.awk: below 12 characters nothing is
  // replaced, so ordinary wording survives.
  const prose = "the request was refused: Bearer of bad news is not a credential"
  assertEquals(redactBridgeSecrets(prose), prose)
})

Deno.test("redactBridgeSecrets redacts a token that is followed by prose", () => {
  const out = redactBridgeSecrets(
    "Authorization : Bearer abcdefghijklmnopqrstuvwxyz0123456789 was rejected",
  )
  assertStringIncludes(out, "Bearer [REDACTED] was rejected")
  assert(!out.includes("abcdefghijklmnopqrstuvwxyz0123456789"))
})

Deno.test("redactBridgeSecrets handles quoted values and any header letter case", () => {
  const out = redactBridgeSecrets(
    'authorization: "Bearer: 0123456789abcdef" and X-INTERNAL-TOKEN = "tok_0123456789abcdef"',
  )
  assertStringIncludes(out, '"[REDACTED]"')
  assert(!out.includes("0123456789abcdef"))
  // the surrounding words stay as they were
  assertStringIncludes(out, "and X-INTERNAL-TOKEN = ")
})

Deno.test("redactBridgeSecrets splits at the bridge's ___ header separator", () => {
  // A credential containing underscores must not be cut short by them, and the
  // separator that follows must survive for the next header.
  const out = redactBridgeSecrets(
    "Headers = Authorization : Bearer aaa_bbb_ccc_ddd_eee_fff_ggg___X-Real-IP : 10.0.0.1",
  )
  assertStringIncludes(out, "Bearer [REDACTED]___X-Real-IP : 10.0.0.1")
  assert(!out.includes("aaa_bbb_ccc_ddd_eee"))
})

Deno.test("MtapiApiError redacts its message on construction", () => {
  const err = new MtapiApiError(MT4_DUMP, 201, "INVALID_TOKEN")
  assert(!String(err.message).includes("FAKEAPIKEY"))
  assert(!String(err.message).includes("FAKEINTERNALTOKEN"))
  assertEquals(err.status, 201)
  assertEquals(err.code, "INVALID_TOKEN")
  // Ordinary bridge codes pass through untouched, so session recovery still matches.
  assertStringIncludes(String(err.message), "Client with id")
})

Deno.test("MtapiApiError redacts a dump carried in the code field too", () => {
  // `{ error: "<dump>" }` is a body shape `errorDetails` explicitly supports:
  // with no `message` field the whole string lands in `code`, which
  // `mtapiFailureSummary()` then forwards into `broker_accounts.connection_error`.
  const err = new MtapiApiError("MTAPI ConnectEx failed", 404, MT4_DUMP)
  assertEquals(err.code?.includes("FAKEAPIKEY"), false, String(err.code))
  assertEquals(err.code?.includes("FAKEINTERNALTOKEN"), false, String(err.code))
  assertStringIncludes(String(err.code), "Client with id = tscopier-probe-not-a-real-session not found")
  // the message path is independent and still clean
  assertEquals(err.message, "MTAPI ConnectEx failed")
})

Deno.test("MtapiApiError leaves ordinary bridge codes untouched", () => {
  for (const code of ["INVALID_TOKEN", "rate_limited", "HTTP_502", "INVALID_ACCOUNT"]) {
    const err = new MtapiApiError("boom", 502, code)
    assertEquals(err.code, code, code)
  }
})

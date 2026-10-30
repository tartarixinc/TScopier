import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { redactBridgeSecrets } from './mtapiRedaction'
import { MtapiApiError } from './mtapiProvider'

// Shape captured live from the MT4 bridge on 2026-10-11 (credential values
// replaced with the same placeholders `deploy/mtapi-log-redactor/test.sh` uses).
const MT4_DUMP =
  'Client with id = tscopier-probe-not-a-real-session not found. ' +
  'Please use /Connect to create new token. Headers = Accept : */*___' +
  'Host : mtapi.tscopier.ai___User-Agent : curl/8.5.0___' +
  'Authorization : Bearer FAKEAPIKEY0000000000000000000000000000000000000000000000000000___' +
  'X-Real-IP : 13.140.44.122___X-Forwarded-For : 13.140.44.122___' +
  'X-Forwarded-Proto : https___' +
  'x-internal-token : FAKEINTERNALTOKEN0000000000000000000000000000000000000000000000000___'

const MT5_MESSAGE = 'Client with id = tscopier-probe-not-a-real-session not found (:0)'

test('redactBridgeSecrets strips both credentials from the MT4 header dump', () => {
  const out = redactBridgeSecrets(MT4_DUMP)
  assert.ok(out.includes('Authorization : Bearer [REDACTED]'), out)
  assert.ok(out.includes('x-internal-token : [REDACTED]'), out)
  assert.equal(out.includes('FAKEAPIKEY'), false, 'the API key must not survive')
  assert.equal(out.includes('FAKEINTERNALTOKEN'), false, 'the internal token must not survive')
})

test('redactBridgeSecrets keeps the session-recovery prefix intact', () => {
  const out = redactBridgeSecrets(MT4_DUMP)
  // isSessionGone() (mtapiProvider.ts:97-101) matches on this phrase; if it were redacted, reconnecting
  // after a bridge restart would stop working.
  assert.ok(out.includes('Client with id = tscopier-probe-not-a-real-session not found'), out)
  assert.ok(out.includes('Please use /Connect to create new token'), out)
  assert.ok(out.includes('Headers = Accept : */*'), out)
  assert.ok(out.includes('X-Real-IP : 13.140.44.122'), out)
})

test('redactBridgeSecrets leaves the clean MT5 message untouched', () => {
  assert.equal(redactBridgeSecrets(MT5_MESSAGE), MT5_MESSAGE)
})

test('redactBridgeSecrets returns empty and unrelated strings unchanged', () => {
  assert.equal(redactBridgeSecrets(''), '')
  assert.equal(redactBridgeSecrets('no credentials here'), 'no credentials here')
})

test('redactBridgeSecrets does not mangle prose that mentions a scheme', () => {
  const prose = 'the request was refused: Bearer of bad news is not a credential'
  assert.equal(redactBridgeSecrets(prose), prose)
})

test('redactBridgeSecrets redacts a token that is followed by prose', () => {
  const out = redactBridgeSecrets(
    'Authorization : Bearer abcdefghijklmnopqrstuvwxyz0123456789 was rejected',
  )
  assert.ok(out.includes('Bearer [REDACTED] was rejected'), out)
  assert.equal(out.includes('abcdefghijklmnopqrstuvwxyz0123456789'), false)
})

test('redactBridgeSecrets handles quoted values and any header letter case', () => {
  const out = redactBridgeSecrets(
    'authorization: "Bearer: 0123456789abcdef" and X-INTERNAL-TOKEN = "tok_0123456789abcdef"',
  )
  assert.ok(out.includes('"[REDACTED]"'), out)
  assert.equal(out.includes('0123456789abcdef'), false, out)
  assert.ok(out.includes('and X-INTERNAL-TOKEN = '), out)
})

test('redactBridgeSecrets splits at the bridge ___ header separator', () => {
  const out = redactBridgeSecrets(
    'Headers = Authorization : Bearer aaa_bbb_ccc_ddd_eee_fff_ggg___X-Real-IP : 10.0.0.1',
  )
  assert.ok(out.includes('Bearer [REDACTED]___X-Real-IP : 10.0.0.1'), out)
  assert.equal(out.includes('aaa_bbb_ccc_ddd_eee'), false, out)
})

test('MtapiApiError redacts its message on construction', () => {
  const err = new MtapiApiError(MT4_DUMP, 201, 'INVALID_TOKEN')
  assert.equal(String(err.message).includes('FAKEAPIKEY'), false)
  assert.equal(String(err.message).includes('FAKEINTERNALTOKEN'), false)
  assert.equal(err.status, 201)
  assert.equal(err.code, 'INVALID_TOKEN')
  // Ordinary bridge codes pass through untouched, so session recovery still matches.
  assert.ok(String(err.message).includes('Client with id'))
})

test('isSessionGone still recognises a redacted bridge message', () => {
  // Reproduces the exact predicate in mtapiProvider.ts:91-93 against the
  // redacted text, so the fix cannot silently break session recovery.
  const err = new MtapiApiError(MT4_DUMP, 201, 'INVALID_TOKEN')
  const text = (String(err.code ?? '') + ' ' + err.message).toUpperCase()
  assert.equal(text.includes('INVALID_TOKEN'), true)
  assert.equal(text.includes('CLIENT WITH ID'), true)
})

test('MtapiApiError redacts a dump carried in the code field too', () => {
  // `{ error: "<dump>" }` is a body shape `errorDetails` explicitly supports:
  // with no `message` field the whole string lands in `code`, which
  // `mtapiFailureSummary()` then forwards into `broker_accounts.connection_error`
  // and `safeCode()` writes into Railway logs.
  const err = new MtapiApiError('MTAPI ConnectEx failed', 404, MT4_DUMP)
  assert.equal(err.code?.includes('FAKEAPIKEY'), false, String(err.code))
  assert.equal(err.code?.includes('FAKEINTERNALTOKEN'), false, String(err.code))
  assert.ok(
    String(err.code).includes('Client with id = tscopier-probe-not-a-real-session not found'),
    String(err.code),
  )
  // the message path is independent and still clean
  assert.equal(err.message, 'MTAPI ConnectEx failed')
})

test('MtapiApiError leaves ordinary bridge codes untouched', () => {
  // `isSessionGone` matches on INVALID_TOKEN, the pre-accept throttle on
  // rate_limited, and log/report code on HTTP_*: none may be rewritten.
  for (const code of ['INVALID_TOKEN', 'rate_limited', 'HTTP_502', 'INVALID_ACCOUNT']) {
    const err = new MtapiApiError('boom', 502, code)
    assert.equal(err.code, code, code)
  }
})

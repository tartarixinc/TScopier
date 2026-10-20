import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { assertPublicMatchtraderHost, normalizeMatchtraderUrl } from './urlSafety'

test('a platform URL is reduced to https and its host', () => {
  assert.deepEqual(normalizeMatchtraderUrl('https://Trade.Broker.com/'), { ok: true, url: 'https://trade.broker.com' })
  assert.deepEqual(normalizeMatchtraderUrl('trade.broker.com'), { ok: true, url: 'https://trade.broker.com' })
  assert.deepEqual(normalizeMatchtraderUrl(' https://trade.broker.com:443 '), { ok: true, url: 'https://trade.broker.com' })
  assert.deepEqual(normalizeMatchtraderUrl('https://trade.broker.com/some/path'), { ok: true, url: 'https://trade.broker.com' })
})

test('unsafe or malformed platform URLs are rejected', () => {
  for (const bad of [
    '',
    'http://trade.broker.com',
    'ftp://trade.broker.com',
    'https://user:pw@trade.broker.com',
    'https://trade.broker.com:8443',
    'https://trade.broker.com/?x=1',
    'https://trade.broker.com/#frag',
    'https://127.0.0.1',
    'https://169.254.169.254',
    'https://[::1]',
    'https://localhost',
    'https://broker',
    'https://db.internal',
    'https://router.local',
    'https://bad_host.com',
  ]) {
    assert.equal(normalizeMatchtraderUrl(bad).ok, false, bad)
  }
})

test('a host that resolves to private space or does not resolve is rejected', async () => {
  await assert.doesNotReject(assertPublicMatchtraderHost('https://trade.broker.com', async () => ['203.0.113.10']))
  await assert.rejects(assertPublicMatchtraderHost('https://trade.broker.com', async () => ['203.0.113.10', '10.0.0.1']), /private address/)
  await assert.rejects(assertPublicMatchtraderHost('https://trade.broker.com', async () => ['127.0.0.1']), /private address/)
  await assert.rejects(assertPublicMatchtraderHost('https://trade.broker.com', async () => { throw new Error('ENOTFOUND') }), /Could not find/)
})

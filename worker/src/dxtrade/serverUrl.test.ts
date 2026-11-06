import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { assertPublicHost, isPrivateIp, normalizeDxtradeServerUrl } from './serverUrl'

test('normalizes broker URLs to the REST base', () => {
  for (const input of [
    'https://trade.broker.com',
    'https://trade.broker.com/',
    'trade.broker.com',
    'https://TRADE.broker.com/dxsca-web',
    'https://trade.broker.com:443/dxsca-web/',
  ]) {
    const result = normalizeDxtradeServerUrl(input)
    assert.deepEqual(result, { ok: true, url: 'https://trade.broker.com/dxsca-web' }, input)
  }
})

test('rejects URLs that could reach internal services', () => {
  for (const input of [
    '',
    'http://trade.broker.com',
    'https://user:pass@trade.broker.com',
    'https://trade.broker.com:8443',
    'https://trade.broker.com?x=1',
    'https://127.0.0.1',
    'https://10.0.0.5/dxsca-web',
    'https://169.254.169.254',
    'https://[::1]',
    'https://localhost',
    'https://intranet',
    'https://db.internal',
    'https://printer.local',
    'https://trade.broker.com/other',
    'ftp://trade.broker.com',
  ]) {
    assert.equal(normalizeDxtradeServerUrl(input).ok, false, input)
  }
})

test('isPrivateIp covers private, loopback and link-local space', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1']) {
    assert.equal(isPrivateIp(ip), true, ip)
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '1.1.1.1', '2606:4700::1111']) {
    assert.equal(isPrivateIp(ip), false, ip)
  }
})

test('assertPublicHost blocks hosts that resolve to private addresses', async () => {
  await assert.rejects(assertPublicHost('https://trade.broker.com/dxsca-web', async () => ['93.184.216.34', '10.0.0.8']), /private address/)
  await assert.rejects(assertPublicHost('https://trade.broker.com/dxsca-web', async () => { throw new Error('ENOTFOUND') }), /Could not find/)
  await assertPublicHost('https://trade.broker.com/dxsca-web', async () => ['93.184.216.34'])
})

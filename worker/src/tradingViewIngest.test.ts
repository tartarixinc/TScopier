import assert from 'node:assert/strict'
import test from 'node:test'
import {
  sha256Hex,
  tradingViewClientIp,
  tradingViewPathToken,
  tradingViewWebhookIpAllowed,
} from './tradingViewIngest'
import { parseTradingViewAlert } from './tradingViewAlert'

test('tradingViewPathToken extracts webhook token', () => {
  assert.equal(tradingViewPathToken('/webhooks/tradingview/abcToken'), 'abcToken')
  assert.equal(tradingViewPathToken('/webhooks/tradingview/_warm'), null)
  assert.equal(tradingViewPathToken('/webhooks/tradingview/'), null)
  assert.equal(tradingViewPathToken('/health'), null)
})

test('tradingViewWebhookIpAllowed respects allowlist env', () => {
  const prev = process.env.TRADINGVIEW_WEBHOOK_IPS
  try {
    delete process.env.TRADINGVIEW_WEBHOOK_IPS
    assert.equal(tradingViewWebhookIpAllowed('1.2.3.4'), true)

    process.env.TRADINGVIEW_WEBHOOK_IPS = '10.0.0.1, 10.0.0.2'
    assert.equal(tradingViewWebhookIpAllowed('10.0.0.1'), true)
    assert.equal(tradingViewWebhookIpAllowed('9.9.9.9'), false)
    assert.equal(tradingViewWebhookIpAllowed(''), false)
  } finally {
    if (prev === undefined) delete process.env.TRADINGVIEW_WEBHOOK_IPS
    else process.env.TRADINGVIEW_WEBHOOK_IPS = prev
  }
})

test('tradingViewClientIp reads first x-forwarded-for hop', () => {
  assert.equal(
    tradingViewClientIp({ 'x-forwarded-for': '203.0.113.1, 10.0.0.1' }),
    '203.0.113.1',
  )
  assert.equal(tradingViewClientIp({ 'x-real-ip': '198.51.100.2' }), '198.51.100.2')
})

test('sha256Hex is stable', () => {
  assert.equal(
    sha256Hex('token'),
    '3c469e9d6c5875d37a43f353d4f88e61fcf812c66eee3457465a40b0da4153e0',
  )
})

test('parseTradingViewAlert still accepts indicator buy bodies used by ingest', () => {
  const result = parseTradingViewAlert(JSON.stringify({
    action: 'buy',
    symbol: 'XAUUSD',
    id: 'alert-1',
    sl: 2640,
    tp: [2660],
  }))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.alert.action, 'buy')
  assert.equal(result.alert.idempotencyId, 'alert-1')
})

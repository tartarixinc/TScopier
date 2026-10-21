import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertPreviewConfiguration,
  buildDemoBrokerAccounts,
  buildDemoTrades,
  CLOSED_TRADES_PER_TRADER,
  DEMO_TRADERS,
  OPEN_TRADES_PER_TRADER,
  PREVIEW_PROJECT_REF,
  summarizeDemoTrades,
} from './seed-social-trading-demo'

test('accepts only the Migration preview URL and a service-role key', () => {
  assert.equal(assertPreviewConfiguration(`https://${PREVIEW_PROJECT_REF}.supabase.co`, 'secret').hostname, `${PREVIEW_PROJECT_REF}.supabase.co`)
  assert.throws(() => assertPreviewConfiguration('https://sxkpcovbyaficvtkpsdo.supabase.co', 'secret'), /blocked/)
  assert.throws(() => assertPreviewConfiguration('https://axdcledcyhyvzrnfkwat.supabase.co', 'secret'), /blocked/)
  assert.throws(() => assertPreviewConfiguration('https://example.supabase.co', 'secret'), /non-preview/)
  assert.throws(() => assertPreviewConfiguration(`https://${PREVIEW_PROJECT_REF}.supabase.co`, ''), /SERVICE_ROLE/)
})

test('uses stable reserved identities and unique source/account ids', () => {
  assert.equal(DEMO_TRADERS.length, 8)
  assert.equal(new Set(DEMO_TRADERS.map(item => item.userId)).size, 8)
  assert.equal(new Set(DEMO_TRADERS.map(item => item.brokerAccountId)).size, 8)
  assert.equal(new Set(DEMO_TRADERS.map(item => item.sourceId)).size, 8)
  assert.ok(DEMO_TRADERS.every(item => item.email.endsWith('@tscopier.invalid') && item.displayName.includes('[DEMO]')))
})

test('creates only credential-free DEMO broker rows for persisted performance', () => {
  const rows = buildDemoBrokerAccounts(new Date('2026-10-21T12:00:00Z'))
  assert.equal(rows.length, 8)
  assert.ok(rows.every(row => row.metaapi_account_id === ''))
  assert.ok(rows.every(row => row.linked_account_type === 'Demo'))
  assert.ok(rows.every(row => String(row.label).includes('synthetic')))
})

test('builds stable, internally consistent rows without hardcoded summary records', () => {
  const anchor = new Date('2026-10-21T12:00:00Z')
  const first = buildDemoTrades(DEMO_TRADERS[0], anchor)
  const second = buildDemoTrades(DEMO_TRADERS[0], anchor)
  assert.deepEqual(first, second)
  assert.equal(first.length, CLOSED_TRADES_PER_TRADER + OPEN_TRADES_PER_TRADER)
  assert.equal(new Set(first.map(row => row.id)).size, first.length)
  const summary = summarizeDemoTrades(first)
  assert.equal(summary.closedTradeCount, CLOSED_TRADES_PER_TRADER)
  assert.equal(summary.realizedProfit, DEMO_TRADERS[0].profits.reduce((sum, value) => sum + value, 0))
  assert.ok((summary.winRate ?? 0) > 0)
  assert.ok((summary.profitFactor ?? 0) > 0)
})

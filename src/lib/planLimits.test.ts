import { strict as assert } from 'node:assert'
import { test } from 'vitest'
import { normalizeManualSettingsForPlan } from './planLimits'

test('basic plan normalization forces single trade style', () => {
  const normalized = normalizeManualSettingsForPlan('basic', 'active', {
    trade_style: 'multi',
    range_trading: true,
  })
  assert.equal(normalized.trade_style, 'single')
  assert.equal(normalized.range_trading, false)
})

test('advanced plan preserves multi trade style', () => {
  const normalized = normalizeManualSettingsForPlan('advanced', 'active', {
    trade_style: 'multi',
    range_trading: true,
  })
  assert.equal(normalized.trade_style, 'multi')
  assert.equal(normalized.range_trading, true)
})

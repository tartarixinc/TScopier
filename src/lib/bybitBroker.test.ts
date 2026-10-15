import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  bybitMarginModeKind,
  bybitSettingsDraftFromBroker,
  parseBybitSettingsDraft,
} from './bybitBroker'

describe('parseBybitSettingsDraft', () => {
  it('accepts valid margin and leverage', () => {
    const parsed = parseBybitSettingsDraft({ marginUsdt: '250.5', leverage: '20' })
    assert.deepEqual(parsed, { ok: true, settings: { marginUsdt: 250.5, leverage: 20 } })
  })

  it('rejects margin that is not a positive number', () => {
    for (const marginUsdt of ['', '0', '-5', 'abc']) {
      assert.deepEqual(parseBybitSettingsDraft({ marginUsdt, leverage: '10' }), { ok: false, field: 'margin' })
    }
  })

  it('rejects leverage outside 1..125 or fractional', () => {
    for (const leverage of ['0', '126', '2.5', '']) {
      assert.deepEqual(parseBybitSettingsDraft({ marginUsdt: '100', leverage }), { ok: false, field: 'leverage' })
    }
  })
})

describe('bybitSettingsDraftFromBroker', () => {
  it('seeds from stored settings and falls back to defaults', () => {
    assert.deepEqual(
      bybitSettingsDraftFromBroker({ bybit_margin_usdt: 75, bybit_leverage: 5 }),
      { marginUsdt: '75', leverage: '5' },
    )
    assert.deepEqual(
      bybitSettingsDraftFromBroker({ bybit_margin_usdt: null, bybit_leverage: null }),
      { marginUsdt: '100', leverage: '10' },
    )
  })
})

describe('bybitMarginModeKind', () => {
  it('maps Bybit margin modes and rejects unknown values', () => {
    assert.equal(bybitMarginModeKind('ISOLATED_MARGIN'), 'isolated')
    assert.equal(bybitMarginModeKind('regular_margin'), 'cross')
    assert.equal(bybitMarginModeKind('PORTFOLIO_MARGIN'), 'portfolio')
    assert.equal(bybitMarginModeKind('SOMETHING'), null)
    assert.equal(bybitMarginModeKind(null), null)
  })
})

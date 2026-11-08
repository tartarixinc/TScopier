import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  binanceSettingsDraftFromBroker,
  parseBinanceSettingsDraft,
} from './binanceBroker'

describe('parseBinanceSettingsDraft', () => {
  it('accepts valid margin, leverage and mode', () => {
    const parsed = parseBinanceSettingsDraft({ marginUsdt: '250.5', leverage: '20', marginMode: 'cross' })
    assert.deepEqual(parsed, { ok: true, settings: { marginUsdt: 250.5, leverage: 20, marginMode: 'cross' } })
  })

  it('rejects margin that is not a positive number', () => {
    for (const marginUsdt of ['', '0', '-5', 'abc']) {
      const parsed = parseBinanceSettingsDraft({ marginUsdt, leverage: '10', marginMode: 'isolated' })
      assert.deepEqual(parsed, { ok: false, field: 'margin' })
    }
  })

  it('rejects leverage outside 1..125 or fractional', () => {
    for (const leverage of ['0', '126', '2.5', '']) {
      const parsed = parseBinanceSettingsDraft({ marginUsdt: '100', leverage, marginMode: 'isolated' })
      assert.deepEqual(parsed, { ok: false, field: 'leverage' })
    }
  })
})

describe('binanceSettingsDraftFromBroker', () => {
  it('uses stored settings and falls back to defaults', () => {
    assert.deepEqual(
      binanceSettingsDraftFromBroker({ binance_margin_usdt: 75, binance_leverage: 5, binance_margin_mode: 'cross' }),
      { marginUsdt: '75', leverage: '5', marginMode: 'cross' },
    )
    assert.deepEqual(
      binanceSettingsDraftFromBroker({ binance_margin_usdt: null, binance_leverage: null, binance_margin_mode: null }),
      { marginUsdt: '100', leverage: '10', marginMode: 'isolated' },
    )
  })
})

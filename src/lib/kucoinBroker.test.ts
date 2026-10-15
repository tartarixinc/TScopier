import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_KUCOIN_SETTINGS_DRAFT,
  kucoinSettingsDraftFromBroker,
  parseKucoinSettingsDraft,
} from './kucoinBroker'

describe('parseKucoinSettingsDraft', () => {
  it('accepts valid margin, leverage and margin mode', () => {
    assert.deepEqual(
      parseKucoinSettingsDraft({ marginUsdt: '250.5', leverage: '20', marginMode: 'cross' }),
      { ok: true, settings: { marginUsdt: 250.5, leverage: 20, marginMode: 'cross' } },
    )
  })

  it('rejects margin that is not a positive number', () => {
    for (const marginUsdt of ['', '0', '-5', 'abc']) {
      assert.deepEqual(
        parseKucoinSettingsDraft({ marginUsdt, leverage: '10', marginMode: 'isolated' }),
        { ok: false, field: 'margin' },
      )
    }
  })

  it('rejects leverage outside 1..125 or fractional', () => {
    for (const leverage of ['0', '126', '2.5', '']) {
      assert.deepEqual(
        parseKucoinSettingsDraft({ marginUsdt: '100', leverage, marginMode: 'isolated' }),
        { ok: false, field: 'leverage' },
      )
    }
  })

  it('rejects an unknown margin mode', () => {
    assert.deepEqual(
      parseKucoinSettingsDraft({ marginUsdt: '100', leverage: '10', marginMode: 'portfolio' as never }),
      { ok: false, field: 'mode' },
    )
  })
})

describe('kucoinSettingsDraftFromBroker', () => {
  it('seeds from stored settings and falls back to defaults', () => {
    assert.deepEqual(
      kucoinSettingsDraftFromBroker({ kucoin_margin_usdt: 75, kucoin_leverage: 5, kucoin_margin_mode: 'cross' }),
      { marginUsdt: '75', leverage: '5', marginMode: 'cross' },
    )
    assert.deepEqual(
      kucoinSettingsDraftFromBroker({ kucoin_margin_usdt: null, kucoin_leverage: null, kucoin_margin_mode: null }),
      DEFAULT_KUCOIN_SETTINGS_DRAFT,
    )
  })
})

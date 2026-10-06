import { describe, expect, it } from 'vitest'
import { configureModalEn } from '../i18n/locales/configureModal/en'
import { en } from '../i18n/locales/en'
import { describeChannelConfiguration } from './configurationSummary'
import type { ManualSettings } from '../types/database'

const copy = en.configurationsPage

function riskValue(settings: ManualSettings, label: string): string | undefined {
  return describeChannelConfiguration(settings, configureModalEn, copy)
    .find(section => section.id === 'risk')
    ?.rows.find(row => row.label === label)
    ?.value
}

describe('describeChannelConfiguration', () => {
  it('lists range-trading risk settings and the planned open-trade count', () => {
    const settings = {
      risk_mode: 'fixed_lot',
      fixed_lot: 5,
      trade_style: 'multi',
      multi_trade_leg_percent: 3,
      use_signal_entry_range: false,
      range_trading: true,
      range_layering_type: 'auto',
      range_percent: 50,
      range_step_pips: 0,
      range_distance_pips: 30,
      range_layer_till_close: false,
    } as ManualSettings

    expect(riskValue(settings, 'Trade Style')).toBe('Range Trading')
    expect(riskValue(settings, 'Risk Mode')).toBe('Fixed Lot')
    expect(riskValue(settings, 'Lot Size')).toBe('5')
    expect(riskValue(settings, 'Per-leg size (% of fixed lot)')).toBe('3')
    expect(riskValue(settings, 'Total Open Trades')).toMatch(/lots x \d+ trades/)
    expect(riskValue(settings, 'Trade Signal Range Only')).toBe('OFF')
    expect(riskValue(settings, 'Range Layering')).toBe('ON')
    expect(riskValue(settings, 'Layering Mode')).toBe('Automatic')
    expect(riskValue(settings, 'Reserved lot (% of total)')).toBe('50')
  })

  it('lists single-entry fields instead of range layering', () => {
    const settings = {
      risk_mode: 'fixed_lot',
      fixed_lot: 0.1,
      trade_style: 'single',
      use_signal_entry_price: false,
    } as ManualSettings

    expect(riskValue(settings, 'Trade Style')).toBe('Single Entry')
    expect(riskValue(settings, 'Lot Size')).toBe('0.1')
    expect(riskValue(settings, 'Range Layering')).toBeUndefined()
    expect(riskValue(settings, 'Use Signal Entry Price')).toBe('OFF')
  })
})

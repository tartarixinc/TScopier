import { interpolate } from '../../i18n/interpolate'
import type { ConfigureModalTranslations } from '../../i18n/locales/configureModal/types'
import type { ChannelFilterKey } from '../../lib/channelMessageFilters'
import type { ManualSettings } from '../../types/database'

export function getChannelFilterCategories(cm: ConfigureModalTranslations) {
  const c = cm.channelFilters.categories
  return (
    [
      'close_full',
      'close_half',
      'break_even',
      'modify_sl',
      'modify_tp',
      'close_tp_levels',
      'close_all',
      'close_worse_entries',
      'delete_pendings',
    ] as const
  ).map(key => ({
    key: key as ChannelFilterKey,
    label: c[key].label,
    example: c[key].example,
  }))
}

export function describePredefinedStopsOverrideI18n(
  ms: ManualSettings,
  stops: ConfigureModalTranslations['stops'],
): string {
  const parts: string[] = []
  if (ms.use_predefined_sl_pips === true) {
    const pips = Number(ms.predefined_sl_pips ?? 0)
    if (Number.isFinite(pips) && pips > 0) {
      parts.push(interpolate(stops.summarySl, { pips: String(pips) }))
    }
  }
  if (ms.use_predefined_tp_pips === true) {
    const tps = (ms.predefined_tp_pips ?? []).map(Number).filter(n => Number.isFinite(n) && n > 0)
    if (tps.length) {
      const list = tps.map(n => `${n} pips`).join(', ')
      parts.push(interpolate(stops.summaryTps, { list }))
    }
  }
  if (!parts.length) return ''
  return interpolate(stops.summaryPrefix, { parts: parts.join(stops.summaryJoin) })
}

function describeAutoBeTriggerI18n(
  ms: ManualSettings,
  mgmt: ConfigureModalTranslations['management'],
): string {
  const mode = ms.move_sl_to_entry_after_mode ?? 'none'
  if (mode === 'none') return ''
  const value = ms.move_sl_to_entry_after_value ?? (mode === 'rr' ? 1 : 10)
  switch (mode) {
    case 'pips':
      return interpolate(mgmt.ruleTriggerPips, { value: String(value) })
    case 'rr':
      return interpolate(mgmt.ruleTriggerRr, { value: String(value) })
    case 'money':
      return interpolate(mgmt.ruleTriggerMoney, { value: String(value) })
    case 'tp_hit':
      return interpolate(mgmt.ruleTriggerTpHit, { index: String(ms.move_sl_to_entry_tp_index ?? 1) })
    default:
      return ''
  }
}

function describeAutoBeActionI18n(
  ms: ManualSettings,
  mgmt: ConfigureModalTranslations['management'],
): string {
  const offset = ms.breakeven_offset_pips ?? 3
  const target =
    offset > 0
      ? interpolate(mgmt.ruleBreakevenOffset, { offset: String(offset) })
      : mgmt.ruleBreakevenTrue
  const type = ms.move_sl_to_entry_type ?? 'sl_only'
  if (type === 'sl_and_close_half') {
    const pct = ms.half_close_percent ?? 50
    return interpolate(mgmt.ruleActionSlAndPartial, { target, pct: String(pct) })
  }
  return interpolate(mgmt.ruleActionSlOnly, { target })
}

export function describeAutoManagementRuleI18n(
  ms: ManualSettings,
  mgmt: ConfigureModalTranslations['management'],
): string {
  const mode = ms.move_sl_to_entry_after_mode ?? 'none'
  if (mode === 'none') return ''
  const trigger = describeAutoBeTriggerI18n(ms, mgmt)
  const action = describeAutoBeActionI18n(ms, mgmt)
  if (!trigger || !action) return ''
  const sentence = `${action.charAt(0).toUpperCase() + action.slice(1)} ${trigger}.`
  return `${mgmt.activeRule} ${sentence}`
}

export function formatPipHintI18n(
  pipHint: ConfigureModalTranslations['pipHint'],
  args: {
    pipCount: number
    symbol: string
    fmtPrice: (n: number) => string
    priceOffset: number
    pipPx: number
    fixedLot: number
    perPip: number
    fmtMoney: (n: number) => string
  },
): string | null {
  const { pipCount, symbol, fmtPrice, priceOffset, pipPx, fixedLot, perPip, fmtMoney } = args
  const distance =
    pipCount > 0
      ? interpolate(pipHint.distance, {
          count: String(pipCount),
          price: fmtPrice(priceOffset),
          symbol,
        })
      : interpolate(pipHint.onePip, { price: fmtPrice(pipPx), symbol })

  if (perPip <= 0) return distance
  const lot = fixedLot.toFixed(2)
  const money =
    pipCount > 0
      ? interpolate(pipHint.atLot, { lot, amount: fmtMoney(perPip * pipCount) })
      : interpolate(pipHint.perPip, { lot, amount: fmtMoney(perPip) })
  return `${distance}${money}`
}

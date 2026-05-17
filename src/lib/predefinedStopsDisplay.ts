import type { ManualSettings } from '../types/database'

export function isPredefinedSlEnabled(ms: ManualSettings): boolean {
  return ms.use_predefined_sl_pips === true
}

export function isPredefinedTpEnabled(ms: ManualSettings): boolean {
  return ms.use_predefined_tp_pips === true
}

export function describePredefinedStopsOverride(ms: ManualSettings): string {
  const parts: string[] = []
  if (isPredefinedSlEnabled(ms)) {
    const pips = Number(ms.predefined_sl_pips ?? 0)
    if (Number.isFinite(pips) && pips > 0) {
      parts.push(`SL ${pips} pips from entry`)
    }
  }
  if (isPredefinedTpEnabled(ms)) {
    const tps = (ms.predefined_tp_pips ?? []).map(Number).filter(n => Number.isFinite(n) && n > 0)
    if (tps.length) {
      parts.push(`TPs at ${tps.map(n => `${n} pips`).join(', ')}`)
    }
  }
  if (!parts.length) return ''
  return `Channel SL/TP are ignored for enabled sides — copier uses ${parts.join('; ')}.`
}

import type { ManualSettings } from '../types/database'

export type AutoBeMode = NonNullable<ManualSettings['move_sl_to_entry_after_mode']>

export function isAutoManagementEnabled(ms: ManualSettings): boolean {
  const mode = ms.move_sl_to_entry_after_mode ?? 'none'
  return mode !== 'none'
}

export function describeAutoBeTrigger(ms: ManualSettings): string {
  const mode = ms.move_sl_to_entry_after_mode ?? 'none'
  if (mode === 'none') return ''
  const value = ms.move_sl_to_entry_after_value ?? (mode === 'rr' ? 1 : 10)
  switch (mode) {
    case 'pips':
      return `after price moves ${value} pip${value === 1 ? '' : 's'} in your favor`
    case 'rr':
      return `at ${value}:1 risk/reward (requires stop loss on the trade)`
    case 'money':
      return `after $${value} unrealized profit`
    case 'tp_hit':
      return `when TP${ms.move_sl_to_entry_tp_index ?? 1} is reached`
    default:
      return ''
  }
}

export function describeAutoBeAction(ms: ManualSettings): string {
  const offset = ms.breakeven_offset_pips ?? 3
  const offsetPart =
    offset > 0 ? `entry + ${offset} pip${offset === 1 ? '' : 's'}` : 'entry (true breakeven)'
  const type = ms.move_sl_to_entry_type ?? 'sl_only'
  if (type === 'sl_and_close_half') {
    const pct = ms.half_close_percent ?? 50
    return `move stop loss to ${offsetPart} and close ${pct}% of the position`
  }
  return `move stop loss to ${offsetPart}`
}

export function describeAutoManagementRule(ms: ManualSettings): string {
  if (!isAutoManagementEnabled(ms)) return ''
  const trigger = describeAutoBeTrigger(ms)
  const action = describeAutoBeAction(ms)
  return trigger && action ? `${action.charAt(0).toUpperCase() + action.slice(1)} ${trigger}.` : ''
}

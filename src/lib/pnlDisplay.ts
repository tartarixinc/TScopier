/** Brand loss red (#E16C6C). */
export const LOSS_COLOR = '#E16C6C'

/** Negative P/L and loss counts. */
export const lossTextClass = 'text-[#E16C6C]'

export const lossBarClass = 'bg-[#E16C6C]'

export const lossBannerClass =
  'bg-error-50 border-error-200 text-[#E16C6C] dark:bg-error-950/40 dark:border-error-800'

export const lossBadgeOutlineClass =
  'border-error-200 text-[#E16C6C] dark:border-error-800'

export const lossIconWrapClass = 'bg-error-50 text-[#E16C6C] dark:bg-error-950/40'

export const profitTextClass = 'text-teal-600 dark:text-teal-400'

export type PnlSignTone = 'good' | 'bad' | 'neutral'

export function backtestToneTextClass(tone: PnlSignTone): string {
  if (tone === 'good') return profitTextClass
  if (tone === 'bad') return lossTextClass
  return 'text-neutral-600 dark:text-neutral-400'
}

export function backtestToneBarClass(tone: PnlSignTone): string {
  if (tone === 'good') return 'bg-teal-500'
  if (tone === 'bad') return lossBarClass
  return 'bg-neutral-300 dark:bg-neutral-600'
}

export function pipValueTextClass(pips: number | null): string {
  if (pips == null || !Number.isFinite(pips)) return 'text-neutral-900 dark:text-neutral-50'
  return pnlSignTextClass(pips)
}

export function isLossPnl(value: number): boolean {
  return Number.isFinite(value) && value < 0
}

export function pnlTone(value: number): 'positive' | 'negative' | 'neutral' {
  if (!Number.isFinite(value) || value === 0) return 'neutral'
  return value > 0 ? 'positive' : 'negative'
}

export function pnlSignTextClass(value: number): string {
  if (isLossPnl(value)) return lossTextClass
  if (value > 0) return profitTextClass
  return 'text-neutral-900 dark:text-neutral-50'
}

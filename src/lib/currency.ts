/** ISO 4217 codes with no fractional units in common trading display. */
export const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'ISK',
  'JPY',
  'KMF',
  'KRW',
  'PYG',
  'RWF',
  'UGX',
  'UYI',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
])

export type BaseCurrencyCode = string

export function normalizeCurrencyCode(code: string | null | undefined): string {
  const c = (code ?? 'USD').trim().toUpperCase()
  return c.length === 3 ? c : 'USD'
}

export function fractionDigitsForCurrency(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(normalizeCurrencyCode(currency)) ? 0 : 2
}

export type FormatMoneyOptions = {
  locale?: string
  /** Show explicit + for positive values (profits). */
  signed?: boolean
  /** Compact axis labels ($1.2M). */
  compact?: boolean
  /** Return em dash when value is null/NaN (default true). */
  nullAsDash?: boolean
}

export function formatMoneyAmount(
  value: number | null | undefined,
  currency: string,
  options: FormatMoneyOptions = {},
): string {
  const { locale, signed = false, compact = false, nullAsDash = true } = options
  if (value == null || !Number.isFinite(value)) {
    return nullAsDash ? '—' : formatMoneyAmount(0, currency, { ...options, nullAsDash: false })
  }

  const cur = normalizeCurrencyCode(currency)
  const n = Number(value)
  const digits = fractionDigitsForCurrency(cur)

  if (compact) {
    return formatCompactMoney(n, cur, locale, digits)
  }

  try {
    const formatted = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: cur,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(Math.abs(n))

    if (!signed) {
      return n < 0 ? `-${formatted.replace(/^-/, '')}` : formatted
    }
    if (n > 0) return `+${formatted}`
    if (n < 0) return `-${formatted.replace(/^-/, '')}`
    return formatted
  } catch {
    const num = Math.abs(n).toFixed(digits)
    const base = `${cur} ${num}`
    if (signed && n > 0) return `+${base}`
    if (n < 0) return `-${base}`
    return base
  }
}

function formatCompactMoney(
  value: number,
  currency: string,
  locale: string | undefined,
  digits: number,
): string {
  const sign = value < 0 ? '-' : ''
  const n = Math.abs(value)
  const symbol = currencySymbol(currency, locale)

  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${sign}${symbol}${m >= 10 ? m.toFixed(0) : m.toFixed(1)}M`
  }
  if (n >= 1_000) {
    const k = n / 1_000
    return `${sign}${symbol}${k >= 100 ? k.toFixed(0) : k.toFixed(1)}k`
  }
  return `${sign}${symbol}${n.toFixed(digits)}`
}

function currencySymbol(currency: string, locale?: string): string {
  try {
    const parts = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: normalizeCurrencyCode(currency),
      currencyDisplay: 'narrowSymbol',
    }).formatToParts(0)
    return parts.find(p => p.type === 'currency')?.value ?? `${currency} `
  } catch {
    return `${currency} `
  }
}

/** Format with an explicit currency code (e.g. broker account currency). */
export function formatMoneyWithCode(
  value: number | null | undefined,
  currency: string | null | undefined,
  options?: FormatMoneyOptions,
): string {
  return formatMoneyAmount(value, normalizeCurrencyCode(currency), options)
}

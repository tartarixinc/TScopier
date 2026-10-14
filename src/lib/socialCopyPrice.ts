import { interpolate } from '../i18n/interpolate'

/** Stored beside the social-trading access setting. Value is USD cents. 0 is free. */
export const COPY_PRICE_STORAGE_KEY = 'tscopier:social-trading:copy-price-cents'

const MAX_COPY_PRICE_CENTS = 1_000_000_00

export function readMonthlyCopyPriceCents(stored: string | null, fallbackCents: number): number {
  const fallback = normalizeCopyPriceCents(fallbackCents)
  if (stored == null || stored.trim() === '') return fallback
  const parsed = Number(stored)
  if (!Number.isInteger(parsed)) return fallback
  return normalizeCopyPriceCents(parsed)
}

export function normalizeCopyPriceCents(cents: number): number {
  if (!Number.isFinite(cents) || cents <= 0) return 0
  return Math.min(MAX_COPY_PRICE_CENTS, Math.round(cents))
}

export function dollarsToCopyPriceCents(dollars: number): number {
  if (!Number.isFinite(dollars) || dollars <= 0) return 0
  return normalizeCopyPriceCents(Math.round(dollars * 100))
}

export function copyPriceOfferLabel(
  cents: number,
  formatAmount: (dollars: number) => string,
  labels: { free: string; paid: string },
): string {
  const price = normalizeCopyPriceCents(cents)
  if (price === 0) return labels.free
  return interpolate(labels.paid, { amount: formatAmount(price / 100) })
}

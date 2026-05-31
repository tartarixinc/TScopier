export interface BillingInvoice {
  id: string
  number: string | null
  periodStart: string | null
  periodEnd: string | null
  created: string
  amountPaid: number
  currency: string
  status: string
  pdfUrl: string | null
  hostedUrl: string | null
}

export interface BillingHistoryResponse {
  invoices: BillingInvoice[]
  hasMore: boolean
  customerId: string | null
  /** Stripe customer balance in cents (negative = credit). */
  balance: number
  billingInterval: 'monthly' | 'annual' | null
  /** Upcoming period amount in cents. */
  currentPeriodAmount: number | null
}

export function customerRefFromUserId(userId: string): string {
  const compact = userId.replace(/-/g, '').slice(0, 4).toUpperCase()
  return `TSC-${compact}`
}

export function formatBillingMoney(cents: number, currency = 'usd', locale?: string): string {
  const amount = Math.abs(cents) / 100
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)
}

export async function fetchBillingHistory(
  accessToken: string,
  options?: { startingAfter?: string; limit?: number },
): Promise<BillingHistoryResponse> {
  const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/billing-history`
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      startingAfter: options?.startingAfter,
      limit: options?.limit ?? 10,
    }),
  })
  const data = (await res.json()) as BillingHistoryResponse & { error?: string }
  if (!res.ok) {
    throw new Error(data.error || 'Failed to load billing history')
  }
  return data
}

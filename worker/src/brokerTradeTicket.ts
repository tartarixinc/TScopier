const MT_TICKET_PATTERN = /^[0-9]+$/
const OPAQUE_TICKET_PROVIDERS = new Set(['ctrader', 'binance', 'bybit', 'kucoin', 'dxtrade', 'tradelocker', 'matchtrader'])

export function normalizeMtBrokerTicket(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null
  }
  if (typeof value !== 'string' || !MT_TICKET_PATTERN.test(value)) return null

  try {
    const ticket = BigInt(value)
    if (ticket <= 0n || ticket > BigInt(Number.MAX_SAFE_INTEGER)) return null
    return ticket.toString()
  } catch {
    return null
  }
}

// Keep the opaque-provider rules (provider set, 255-length cap, control-char
// rejection) in sync with the frontend twin
// `src/lib/socialAccount.ts` → `normalizeSocialBrokerTicket`; that copy only
// ever sees DB strings, so it has no number branch.
export function normalizeBrokerTradeTicket(provider: string | null | undefined, value: unknown): string | null {
  const normalizedProvider = provider?.trim().toLowerCase() || 'fxsocket'
  if (normalizedProvider === 'fxsocket' || normalizedProvider === 'mtapi') return normalizeMtBrokerTicket(value)

  if (!OPAQUE_TICKET_PROVIDERS.has(normalizedProvider)) return null
  // Opaque providers keep their native id shape, but callers hand over the
  // provider's `result.ticket`, which is a number (cTrader positionId and
  // friends). String-only acceptance silently nulled every cTrader
  // `metaapi_order_id` — the row could then never be closed by ticket and
  // showed `ticket=-` everywhere. Accept a finite positive integer by
  // stringifying it; non-integral, non-finite and non-positive numbers stay
  // rejected like any other malformed id.
  let ticket: string
  if (typeof value === 'string') {
    ticket = value
  } else if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    ticket = String(value)
  } else {
    return null
  }
  ticket = ticket.trim()
  if (ticket.length === 0 || ticket.length > 255) return null
  for (let i = 0; i < ticket.length; i += 1) {
    const code = ticket.charCodeAt(i)
    if (code < 32 || code === 127) return null
  }
  return ticket
}

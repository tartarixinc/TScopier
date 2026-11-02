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

export function normalizeBrokerTradeTicket(provider: string | null | undefined, value: unknown): string | null {
  const normalizedProvider = provider?.trim().toLowerCase() || 'fxsocket'
  if (normalizedProvider === 'fxsocket' || normalizedProvider === 'mtapi') return normalizeMtBrokerTicket(value)

  if (!OPAQUE_TICKET_PROVIDERS.has(normalizedProvider) || typeof value !== 'string') return null
  const ticket = value.trim()
  return ticket.length > 0 && ticket.length <= 255 && !/[\u0000-\u001f\u007f]/.test(ticket) ? ticket : null
}

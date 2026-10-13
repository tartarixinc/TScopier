/** cTrader Open API payload types and order mapping. No network. */

export const CTRADER_PAYLOAD = {
  HEARTBEAT: 51,
  APPLICATION_AUTH_REQ: 2100,
  APPLICATION_AUTH_RES: 2101,
  ACCOUNT_AUTH_REQ: 2102,
  ACCOUNT_AUTH_RES: 2103,
  NEW_ORDER_REQ: 2106,
  CANCEL_ORDER_REQ: 2108,
  AMEND_ORDER_REQ: 2109,
  AMEND_POSITION_SLTP_REQ: 2110,
  CLOSE_POSITION_REQ: 2111,
  ASSET_LIST_REQ: 2112,
  ASSET_LIST_RES: 2113,
  SYMBOLS_LIST_REQ: 2114,
  SYMBOLS_LIST_RES: 2115,
  SYMBOL_BY_ID_REQ: 2116,
  SYMBOL_BY_ID_RES: 2117,
  TRADER_REQ: 2121,
  TRADER_RES: 2122,
  RECONCILE_REQ: 2124,
  RECONCILE_RES: 2125,
  EXECUTION_EVENT: 2126,
  SUBSCRIBE_SPOTS_REQ: 2127,
  SUBSCRIBE_SPOTS_RES: 2128,
  SPOT_EVENT: 2131,
  ORDER_ERROR_EVENT: 2132,
  DEAL_LIST_REQ: 2133,
  DEAL_LIST_RES: 2134,
  ERROR_RES: 2142,
  GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ: 2149,
  GET_ACCOUNTS_BY_ACCESS_TOKEN_RES: 2150,
} as const

export const CTRADER_ORDER_TYPE = {
  MARKET: 1,
  LIMIT: 2,
  STOP: 3,
  STOP_LOSS_TAKE_PROFIT: 4,
  MARKET_RANGE: 5,
  STOP_LIMIT: 6,
} as const

export const CTRADER_TRADE_SIDE = {
  BUY: 1,
  SELL: 2,
} as const

/** ProtoOAExecutionType values that mean the order did not land. */
export const CTRADER_REJECTED_EXECUTION = new Set([7, 8])

const CTRADER_PAYLOAD_BY_NAME: Record<string, number> = {
  HEARTBEAT_EVENT: CTRADER_PAYLOAD.HEARTBEAT,
  PROTO_HEARTBEAT_EVENT: CTRADER_PAYLOAD.HEARTBEAT,
  PROTO_OA_APPLICATION_AUTH_RES: CTRADER_PAYLOAD.APPLICATION_AUTH_RES,
  PROTO_OA_ACCOUNT_AUTH_RES: CTRADER_PAYLOAD.ACCOUNT_AUTH_RES,
  PROTO_OA_SYMBOLS_LIST_RES: CTRADER_PAYLOAD.SYMBOLS_LIST_RES,
  PROTO_OA_SYMBOL_BY_ID_RES: CTRADER_PAYLOAD.SYMBOL_BY_ID_RES,
  PROTO_OA_TRADER_RES: CTRADER_PAYLOAD.TRADER_RES,
  PROTO_OA_RECONCILE_RES: CTRADER_PAYLOAD.RECONCILE_RES,
  PROTO_OA_EXECUTION_EVENT: CTRADER_PAYLOAD.EXECUTION_EVENT,
  PROTO_OA_SUBSCRIBE_SPOTS_RES: CTRADER_PAYLOAD.SUBSCRIBE_SPOTS_RES,
  PROTO_OA_SPOT_EVENT: CTRADER_PAYLOAD.SPOT_EVENT,
  PROTO_OA_ORDER_ERROR_EVENT: CTRADER_PAYLOAD.ORDER_ERROR_EVENT,
  PROTO_OA_DEAL_LIST_RES: CTRADER_PAYLOAD.DEAL_LIST_RES,
  PROTO_OA_ERROR_RES: CTRADER_PAYLOAD.ERROR_RES,
  PROTO_OA_GET_ACCOUNTS_BY_ACCESS_TOKEN_RES: CTRADER_PAYLOAD.GET_ACCOUNTS_BY_ACCESS_TOKEN_RES,
}

const CTRADER_EXECUTION_BY_NAME: Record<string, number> = {
  ORDER_ACCEPTED: 2,
  ORDER_FILLED: 3,
  ORDER_REPLACED: 4,
  ORDER_CANCELLED: 5,
  ORDER_CANCELED: 5,
  ORDER_EXPIRED: 6,
  ORDER_REJECTED: 7,
  ORDER_CANCEL_REJECTED: 8,
  ORDER_PARTIAL_FILL: 11,
}

function canonEnum(value: unknown): string {
  return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function lookupEnum(table: Record<string, number>, value: unknown): number | undefined {
  const key = canonEnum(value)
  if (!key) return undefined
  for (const [name, id] of Object.entries(table)) {
    if (canonEnum(name) === key) return id
  }
  return undefined
}

/** Numeric payload type, including ProtoOAExecutionEvent-style names. */
export function ctraderPayloadType(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const numeric = Number(value)
    if (numeric > 0) return numeric
  }
  return lookupEnum(CTRADER_PAYLOAD_BY_NAME, value) ?? Number.NaN
}

/** Numeric execution type, including ORDER_FILLED-style names. */
export function ctraderExecutionType(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric
  }
  return lookupEnum(CTRADER_EXECUTION_BY_NAME, value)
}

export const CTRADER_FULL_ACCESS = 0

export function ctraderSocketUrl(environment: string | null | undefined): string {
  const host = String(environment ?? '').trim().toLowerCase() === 'live'
    ? 'live.ctraderapi.com'
    : 'demo.ctraderapi.com'
  return `wss://${host}:5036`
}

export function ctraderAuthorizeUrl(args: {
  clientId: string
  redirectUri: string
  state: string
}): string {
  const url = new URL('https://id.ctrader.com/my/settings/openapi/grantingaccess/')
  url.searchParams.set('client_id', args.clientId)
  url.searchParams.set('redirect_uri', args.redirectUri)
  url.searchParams.set('scope', 'trading')
  url.searchParams.set('product', 'web')
  url.searchParams.set('state', args.state)
  return url.toString()
}

export function ctraderTokenUrl(query: Record<string, string>): string {
  const url = new URL('https://openapi.ctrader.com/apps/token')
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  return url.toString()
}

export function readCtraderTokenResponse(body: unknown): {
  accessToken: string
  refreshToken: string
  expiresIn: number
} {
  const row = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  const accessToken = String(row.accessToken ?? row.access_token ?? '').trim()
  const refreshToken = String(row.refreshToken ?? row.refresh_token ?? '').trim()
  const expiresIn = Number(row.expiresIn ?? row.expires_in ?? 0)
  if (!accessToken) throw new Error('cTrader did not return an access token')
  return {
    accessToken,
    refreshToken,
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 0,
  }
}

/** cTrader volume is 0.01 of a unit. Symbol lotSize is already in those units. */
export function lotsToCtraderVolume(lots: number, lotSize: number): number {
  if (!Number.isFinite(lots) || lots <= 0) throw new Error('Volume must be greater than zero')
  if (!Number.isFinite(lotSize) || lotSize <= 0) throw new Error('Symbol lot size is missing')
  return Math.round(lots * lotSize)
}

export function ctraderVolumeToLots(volume: number, lotSize: number): number {
  if (!Number.isFinite(volume) || !Number.isFinite(lotSize) || lotSize <= 0) return 0
  return volume / lotSize
}

/**
 * A market execution is usable once the position id, fill price, and volume
 * are present. The earlier accepted event often has only an order id.
 */
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : Array.isArray(value) && value[0] && typeof value[0] === 'object'
      ? value[0] as Record<string, unknown>
      : {}
}

export function ctraderMarketFillReady(payload: Record<string, unknown>): boolean {
  const executionType = ctraderExecutionType(payload.executionType)
  if (executionType === 3 || executionType === 11) return true
  if (executionType === 5 || executionType === 6 || executionType === 7 || executionType === 8) return true
  const position = record(payload.position)
  const deal = record(payload.deal)
  const trade = record(position.tradeData)
  const positionId = Number(position.positionId ?? deal.positionId)
  const price = Number(position.price ?? deal.executionPrice)
  const volume = Number(trade.volume ?? position.volume ?? deal.filledVolume ?? deal.volume)
  return Number.isFinite(positionId) && positionId > 0
    && Number.isFinite(price) && price > 0
    && Number.isFinite(volume) && volume > 0
}

/** Live spot quotes use 1/100000 of a price unit, for every symbol. */
export const CTRADER_SPOT_PRICE_SCALE = 100_000

export function ctraderSpotPrice(relative: number): number {
  return relative / CTRADER_SPOT_PRICE_SCALE
}

export function priceToRelative(price: number, digits: number): number {
  const scale = 10 ** (Number.isFinite(digits) ? digits : 5)
  return Math.round(price * scale)
}

export function relativeToPrice(relative: number, digits: number): number {
  const scale = 10 ** (Number.isFinite(digits) ? digits : 5)
  return relative / scale
}

export function moneyFromCents(value: unknown): number | undefined {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return undefined
  return amount / 100
}

export function mapCtraderOrder(operation: string): { orderType: number; tradeSide: number } {
  switch (operation) {
    case 'Buy':
      return { orderType: CTRADER_ORDER_TYPE.MARKET, tradeSide: CTRADER_TRADE_SIDE.BUY }
    case 'Sell':
      return { orderType: CTRADER_ORDER_TYPE.MARKET, tradeSide: CTRADER_TRADE_SIDE.SELL }
    case 'BuyLimit':
      return { orderType: CTRADER_ORDER_TYPE.LIMIT, tradeSide: CTRADER_TRADE_SIDE.BUY }
    case 'SellLimit':
      return { orderType: CTRADER_ORDER_TYPE.LIMIT, tradeSide: CTRADER_TRADE_SIDE.SELL }
    case 'BuyStop':
      return { orderType: CTRADER_ORDER_TYPE.STOP, tradeSide: CTRADER_TRADE_SIDE.BUY }
    case 'SellStop':
      return { orderType: CTRADER_ORDER_TYPE.STOP, tradeSide: CTRADER_TRADE_SIDE.SELL }
    case 'BuyStopLimit':
      return { orderType: CTRADER_ORDER_TYPE.STOP_LIMIT, tradeSide: CTRADER_TRADE_SIDE.BUY }
    case 'SellStopLimit':
      return { orderType: CTRADER_ORDER_TYPE.STOP_LIMIT, tradeSide: CTRADER_TRADE_SIDE.SELL }
    default:
      throw new Error(`Unsupported cTrader order type: ${operation}`)
  }
}

export function operationFromCtrader(orderType: number, tradeSide: number): string {
  const buy = tradeSide !== CTRADER_TRADE_SIDE.SELL
  if (orderType === CTRADER_ORDER_TYPE.LIMIT) return buy ? 'BuyLimit' : 'SellLimit'
  if (orderType === CTRADER_ORDER_TYPE.STOP) return buy ? 'BuyStop' : 'SellStop'
  if (orderType === CTRADER_ORDER_TYPE.STOP_LIMIT) return buy ? 'BuyStopLimit' : 'SellStopLimit'
  return buy ? 'Buy' : 'Sell'
}

export function ctraderErrorMessage(payload: unknown): string {
  const row = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const description = String(row.description ?? row.errorCode ?? '').trim()
  return description || 'cTrader rejected the request'
}

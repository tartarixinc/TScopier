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

import type { BrokerAccount } from '../types/database'

/** Legacy rows stored `metaapi_account_id` as `ServerName|Login`. */
export function legacyServerFromMetaapiId(metaapiAccountId: string | null | undefined): string | null {
  const id = (metaapiAccountId ?? '').trim()
  const pipe = id.indexOf('|')
  if (pipe <= 0) return null
  const left = id.slice(0, pipe).trim()
  return left || null
}

/**
 * Best server string to infer broker from: provider hint, DB column, then legacy metaapi format.
 */
export function resolveMtServerCandidate(
  account: BrokerAccount,
  providerHint?: string | null,
): string | null {
  const h = (providerHint ?? '').trim()
  if (h) return h
  const fromCol = account.broker_server?.trim()
  if (fromCol) return fromCol
  return legacyServerFromMetaapiId(account.metaapi_account_id)
}

/**
 * Best-effort broker display name from an MT server string.
 * Prefer API-provided broker when available; use this as fallback.
 */
export function inferBrokerLabelFromServer(server: string | null | undefined): string | null {
  const s = (server ?? '').trim()
  if (!s) return null
  const lower = s.toLowerCase()

  const rules: readonly (readonly [string, string])[] = [
    ['icmarkets', 'IC Markets'],
    ['exness', 'Exness'],
    ['ftmo', 'FTMO'],
    ['deriv', 'Deriv'],
    ['eightcap', 'Eightcap'],
    ['vpfx', 'VPFX'],
    ['m4markets', 'M4 Markets'],
    ['olympicmarkets', 'Olympic Markets'],
    ['hfmarkets', 'HFM'],
    ['fxdd', 'FXDD'],
    ['vtmarkets', 'VT Markets'],
    ['lmax', 'LMAX'],
    ['robomarkets', 'RoboMarkets'],
    ['trading.com', 'Trading.com'],
    ['metaquotes', 'MetaQuotes'],
    ['pepperstone', 'Pepperstone'],
    ['oanda', 'OANDA'],
    ['fxtm', 'FXTM'],
    ['admiral', 'Admirals'],
    ['tickmill', 'Tickmill'],
    ['thinkmarkets', 'ThinkMarkets'],
    ['vantage', 'Vantage'],
    ['fusion markets', 'Fusion Markets'],
    ['global prime', 'Global Prime'],
    ['xm.com', 'XM'],
    ['xmglobal', 'XM'],
    ['justmarkets', 'JustMarkets'],
    ['axi', 'Axi'],
    ['fp markets', 'FP Markets'],
    ['blackbull', 'BlackBull'],
    ['blueberry', 'Blueberry'],
    ['dukascopy', 'Dukascopy'],
  ]

  for (const [needle, label] of rules) {
    if (lower.includes(needle)) return label
  }

  // XM without "xm.com" in string
  if (/\bxm\b/.test(lower) || lower.startsWith('xm-')) return 'XM'

  const first = s.split(/[-_/]/)[0]?.trim() ?? ''
  if (first.length < 2) return s

  const spaced = first.replace(/([a-z\d])([A-Z])/g, '$1 $2')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

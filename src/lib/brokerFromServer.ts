import type { BrokerAccount } from '../types/database'

/** Legacy rows stored `metaapi_account_id` as `ServerName|Login`. */
export function legacyServerFromMetaapiId(metaapiAccountId: string | null | undefined): string | null {
  const id = (metaapiAccountId ?? '').trim()
  const pipe = id.indexOf('|')
  if (pipe <= 0) return null
  const left = id.slice(0, pipe).trim()
  return left || null
}

/** Legacy MT login from `ServerName|Login` in metaapi_account_id. */
export function legacyLoginFromMetaapiId(metaapiAccountId: string | null | undefined): string | null {
  const id = (metaapiAccountId ?? '').trim()
  const pipe = id.indexOf('|')
  if (pipe < 0 || pipe >= id.length - 1) return null
  const login = id.slice(pipe + 1).trim()
  return login || null
}

/** MT account number for display (DB column, then legacy link format). */
export function resolveAccountLogin(account: BrokerAccount): string | null {
  const fromCol = (account.account_login ?? '').trim()
  if (fromCol) return fromCol
  return legacyLoginFromMetaapiId(account.metaapi_account_id)
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

export type LinkedAccountType = 'Live' | 'Demo'

/** Parse MT AccountSummary `type` (e.g. ACCOUNT_TRADE_MODE_DEMO, "0", "2"). */
export function parseMtAccountTradeMode(
  mtSummaryType?: string | number | null,
): LinkedAccountType | undefined {
  if (mtSummaryType === 0 || mtSummaryType === '0') return 'Demo'
  if (mtSummaryType === 1 || mtSummaryType === '1') return 'Demo' // contest
  if (mtSummaryType === 2 || mtSummaryType === '2') return 'Live'
  const t = String(mtSummaryType ?? '').trim().toLowerCase()
  if (!t) return undefined
  if (t.includes('demo') || t.includes('contest') || t.includes('test')) return 'Demo'
  if (t.includes('real') || t.includes('live')) return 'Live'
  return undefined
}

/** Infer Demo vs Live from the MT server hostname (e.g. ICMarkets-Demo, FTMO-Server-Live). */
export function inferAccountTypeFromServer(server?: string | null): LinkedAccountType | undefined {
  const s = (server ?? '').trim().toLowerCase()
  if (!s) return undefined
  if (/\bdemo\b/.test(s) || s.includes('-demo') || s.endsWith('demo')) return 'Demo'
  if (/\blive\b/.test(s) || /\breal\b/.test(s) || s.includes('-live') || s.endsWith('live')) {
    return 'Live'
  }
  return undefined
}

/** Prefer broker-reported trade mode; fall back to server name heuristics. */
export function resolveLinkedAccountType(
  mtSummaryType?: string | number | null,
  server?: string | null,
): LinkedAccountType | undefined {
  return parseMtAccountTradeMode(mtSummaryType) ?? inferAccountTypeFromServer(server)
}

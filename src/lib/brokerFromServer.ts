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

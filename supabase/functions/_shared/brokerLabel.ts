/** Best-effort broker display name from an MT server string (edge + sync). */
export function inferBrokerLabel(server: string): string {
  const s = (server ?? "").trim()
  if (!s) return ""
  const lower = s.toLowerCase()
  const rules: [string, string][] = [
    ["icmarkets", "IC Markets"],
    ["exness", "Exness"],
    ["ftmo", "FTMO"],
    ["deriv", "Deriv"],
    ["eightcap", "Eightcap"],
    ["vpfx", "VPFX"],
    ["m4markets", "M4 Markets"],
    ["olympicmarkets", "Olympic Markets"],
    ["hfmarkets", "HFM"],
    ["fxdd", "FXDD"],
    ["vtmarkets", "VT Markets"],
    ["lmax", "LMAX"],
    ["robomarkets", "RoboMarkets"],
    ["trading.com", "Trading.com"],
    ["metaquotes", "MetaQuotes"],
    ["pepperstone", "Pepperstone"],
    ["oanda", "OANDA"],
    ["fxtm", "FXTM"],
    ["admiral", "Admirals"],
    ["tickmill", "Tickmill"],
    ["thinkmarkets", "ThinkMarkets"],
    ["vantage", "Vantage"],
    ["fusion markets", "Fusion Markets"],
    ["global prime", "Global Prime"],
    ["xmglobal", "XM"],
    ["justmarkets", "JustMarkets"],
    ["blackbull", "BlackBull"],
    ["blueberry", "Blueberry"],
    ["dukascopy", "Dukascopy"],
  ]
  for (const [needle, label] of rules) {
    if (lower.includes(needle)) return label
  }
  if (/\bxm\b/.test(lower) || lower.startsWith("xm-")) return "XM"
  const first = s.split(/[-_/]/)[0]?.trim() ?? ""
  if (first.length < 2) return s
  return first.charAt(0).toUpperCase() + first.slice(1)
}

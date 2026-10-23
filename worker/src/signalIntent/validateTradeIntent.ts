import { looksLikeCasualNonTradeMessage } from '../signalCommentaryGuard'
import { sanitizeParsedSymbol } from '../tradableSymbol'
import type { TradeIntent } from './tradeIntent'

export type TradeIntentValidationResult =
  | { ok: true; intent: TradeIntent }
  | { ok: false; reason: string; intent: TradeIntent }

/** Extract numeric tokens from source text for hallucination guard. */
function sourcePriceTokens(rawMessage: string): Set<string> {
  const tokens = new Set<string>()
  const re = /\d+(?:\.\d+)?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(rawMessage)) != null) {
    tokens.add(m[0]!)
    const n = Number(m[0])
    if (Number.isFinite(n)) {
      tokens.add(String(n))
      if (Number.isInteger(n)) tokens.add(String(n) + '.0')
    }
  }
  return tokens
}

function priceAppearsInSource(value: number, sourceTokens: Set<string>): boolean {
  const s = String(value)
  if (sourceTokens.has(s)) return true
  const rounded = value.toFixed(2)
  if (sourceTokens.has(rounded)) return true
  const int = String(Math.round(value))
  return sourceTokens.has(int)
}

function validatePricesFromSource(intent: TradeIntent, rawMessage: string): string | null {
  const tokens = sourcePriceTokens(rawMessage)

  // A message without a single number cannot name an absolute price. This is the
  // common "SL TO BE" / "take partials" case: the model sometimes fills in the
  // stop it remembers from the open trade, which would move a breakeven stop
  // back to the original loss level. Reject every price for such messages.
  const check = (v: number | null | undefined): boolean =>
    v == null || v <= 0 || (tokens.size > 0 && priceAppearsInSource(v, tokens))

  if (!check(intent.sl)) return 'invented_sl'
  for (const e of intent.entry) {
    if (!check(e)) return 'invented_entry'
  }
  for (const t of intent.tp) {
    if (!check(t)) return 'invented_tp'
  }
  return null
}

/** Language-agnostic validation after AI extraction, before adapter. */
export function validateTradeIntent(
  intent: TradeIntent,
  rawMessage: string,
): TradeIntentValidationResult {
  const raw = String(rawMessage ?? '').trim()
  if (!raw) {
    return { ok: false, reason: 'empty_message', intent: { ...intent, kind: 'ignore' } }
  }

  if (looksLikeCasualNonTradeMessage(raw)) {
    return {
      ok: false,
      reason: 'commentary_not_trade_signal',
      intent: { ...intent, kind: 'commentary' },
    }
  }

  if (intent.kind === 'commentary' || intent.kind === 'ignore') {
    return { ok: true, intent }
  }

  const invented = validatePricesFromSource(intent, raw)
  if (invented) {
    return {
      ok: false,
      reason: `intent_validation_failed:${invented}`,
      intent: { ...intent, kind: 'ignore', confidence: 0 },
    }
  }

  const symbol = sanitizeParsedSymbol(intent.symbol)
  const normalized: TradeIntent = {
    ...intent,
    symbol: symbol ?? intent.symbol,
  }

  if (intent.kind === 'entry' && !intent.side) {
    return {
      ok: false,
      reason: 'entry_missing_side',
      intent: { ...normalized, kind: 'ignore' },
    }
  }

  return { ok: true, intent: normalized }
}

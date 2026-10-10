/**
 * Modification grounding: SL/TP modification messages often omit the symbol
 * ("Move the Stop loss to 4280", "You can add a Take Profit of 30 pips").
 * The model must infer it from context — and when it guesses wrong it can
 * target a closed trade or an unrelated symbol. This module grounds
 * modifications to the user's actually-OPEN trades for the channel.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { symbolsCompatibleForBasket } from './basketModFollowUp'
import { textLooksLikeMultilingualFullClose } from './multilingualManagementTerms'
import type { TradeIntent } from './signalIntent/tradeIntent'

export const MODIFICATION_NO_OPEN_TRADE_REASON = 'modification_no_open_trade'
export const MODIFICATION_PARENT_SYMBOL_CONFLICT_REASON = 'modification_parent_symbol_conflict'

export type OpenTradeRef = {
  symbol: string
  direction: 'BUY' | 'SELL' | string
}

const RECENT_SIGNAL_WINDOW = 50

/**
 * Load the symbol from the parent signal's parsed data (the signal the
 * Telegram reply points at). The parent's symbol is ground truth for a
 * replied-to modification — the channel told us which trade it means.
 */
export async function loadParentSignalSymbol(
  supabase: SupabaseClient,
  parentSignalId: string | null | undefined,
): Promise<string | null> {
  if (!parentSignalId) return null
  try {
    const { data } = await supabase
      .from('signals')
      .select('parsed_data')
      .eq('id', parentSignalId)
      .maybeSingle()
    const parsed = (data as { parsed_data?: Record<string, unknown> | null } | null)?.parsed_data
    const symbol = String(parsed?.symbol ?? '').trim().toUpperCase()
    return symbol || null
  } catch {
    return null
  }
}

export type ParentSymbolResolution =
  | { kind: 'no_parent' }
  | { kind: 'ok' }
  | { kind: 'fill'; symbol: string }
  | { kind: 'conflict'; modelSymbol: string; parentSymbol: string }

/**
 * Reply-based symbol enforcement. When the message is a Telegram reply with a
 * resolved parent signal symbol:
 * - model omitted the symbol → fill with the parent's symbol (the reply IS the
 *   instruction about which trade).
 * - model matches the parent → ok.
 * - model contradicts the parent → conflict (final model or skip; never
 *   silently target a different trade).
 */
export function resolveModificationParentSymbol(args: {
  parentSymbol: string | null
  modelSymbol: string | null
}): ParentSymbolResolution {
  const parent = String(args.parentSymbol ?? '').trim().toUpperCase()
  const model = String(args.modelSymbol ?? '').trim().toUpperCase()
  if (!parent) return { kind: 'no_parent' }
  if (!model) return { kind: 'fill', symbol: parent }
  if (symbolsCompatibleForBasket(parent, model)) return { kind: 'ok' }
  return { kind: 'conflict', modelSymbol: model, parentSymbol: parent }
}

/**
 * Load the user's open trades whose signals came from this channel.
 * Closed trades are excluded — a modification targeting a closed trade is stale.
 * Returns null when the query fails (caller must fail open — never block the
 * normal parse flow on missing trade data).
 */
export async function loadOpenTradesForChannel(
  supabase: SupabaseClient,
  args: { userId: string; channelRowId: string },
): Promise<OpenTradeRef[] | null> {
  try {
    const { data: channelSignals } = await supabase
      .from('signals')
      .select('id')
      .eq('user_id', args.userId)
      .eq('channel_id', args.channelRowId)
      .order('created_at', { ascending: false })
      .limit(RECENT_SIGNAL_WINDOW)
    const ids = (channelSignals ?? []).map(r => String((r as { id?: string }).id ?? '').trim()).filter(Boolean)
    if (ids.length === 0) return []

    const { data: openTrades } = await supabase
      .from('trades')
      .select('symbol, direction')
      .eq('user_id', args.userId)
      .eq('status', 'open')
      .in('signal_id', ids)
      .limit(RECENT_SIGNAL_WINDOW)
    const seen = new Set<string>()
    const refs: OpenTradeRef[] = []
    for (const t of (openTrades ?? []) as Array<{ symbol?: string | null; direction?: string | null }>) {
      const symbol = String(t.symbol ?? '').trim().toUpperCase()
      if (!symbol || seen.has(symbol)) continue
      seen.add(symbol)
      refs.push({ symbol, direction: String(t.direction ?? '').trim().toUpperCase() })
    }
    return refs
  } catch {
    return null
  }
}

/** True when the modification intent's symbol matches an open trade in the channel.
 *  Uses the same broker-suffix-tolerant comparison as the rest of the system
 *  (XAUUSD ↔ XAUUSDm) — the trades table stores the broker symbol. */
export function modificationTargetsOpenTrade(
  intent: Pick<TradeIntent, 'symbol'>,
  openTrades: OpenTradeRef[],
): boolean {
  const sym = String(intent.symbol ?? '').trim().toUpperCase()
  if (!sym) return false
  return openTrades.some(t => symbolsCompatibleForBasket(sym, t.symbol))
}

/**
 * A `close` with no symbol AND an explicit "close all / everything" cue is a
 * global close-all — it targets every open trade in the channel by design. The
 * symbol-match in `modificationTargetsOpenTrade` exists to catch a *guessed*
 * symbol and would always reject an empty one, so this case is grounded against
 * the whole open-trade list instead.
 *
 * The cue is required: a bare symbol-less `close` ("close now", "close it") is
 * exactly the ambiguous case the grounding layer exists to absorb — without the
 * cue it must fall through to the normal skip/reconcile path rather than
 * liquidating the channel.
 */
export function isSymbolLessCloseIntent(
  intent: Pick<TradeIntent, 'kind' | 'symbol'>,
  rawMessage: string,
): boolean {
  return intent.kind === 'close'
    && !String(intent.symbol ?? '').trim()
    && textLooksLikeMultilingualFullClose(rawMessage)
}

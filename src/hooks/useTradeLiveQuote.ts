import { useEffect, useState } from 'react'
import { fxsocketBroker } from '../lib/fxsocketBroker'
import { supabase } from '../lib/supabase'
import {
  liveExitPrice,
  normalizeTradeQuote,
  shouldPollTradeQuote,
  type LiveQuoteTrade,
  type NormalizedTradeQuote,
} from '../lib/tradeLiveQuote'

/** One refresh per interval while the detail modal is open — keeps edge/broker load low. */
export const LIVE_QUOTE_POLL_MS = 10_000

export interface TradeLiveQuoteState {
  quote: NormalizedTradeQuote | null
  /** Exit-side price for this trade's direction (buy→bid, sell→ask). */
  price: number | null
  loading: boolean
  error: string | null
  updatedAt: number | null
}

const IDLE: TradeLiveQuoteState = {
  quote: null,
  price: null,
  loading: false,
  error: null,
  updatedAt: null,
}

/** Internal state is keyed to trade identity so a stale quote cannot leak across trades. */
type InternalState = TradeLiveQuoteState & { key: string | null }

const IDLE_INTERNAL: InternalState = { ...IDLE, key: null }

/** Cache provider per broker row so reopening the modal does not re-query. */
const providerByBrokerId = new Map<string, 'fxsocket' | 'mtapi'>()

async function resolveQuoteProvider(brokerId: string, userId: string): Promise<'fxsocket' | 'mtapi'> {
  const cached = providerByBrokerId.get(brokerId)
  if (cached) return cached
  const { data, error } = await supabase
    .from('broker_accounts')
    .select('provider')
    .eq('id', brokerId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  const provider = data?.provider === 'mtapi' ? 'mtapi' : 'fxsocket'
  providerByBrokerId.set(brokerId, provider)
  return provider
}

/**
 * Live bid/ask for one open trade while the detail modal is shown.
 * Fetches immediately, then at most once every {@link LIVE_QUOTE_POLL_MS}.
 * Pauses while the tab is hidden and when no poll is needed (closed / missing ids).
 * On fetch failure the price is cleared (UI shows an em dash, not a stale number).
 */
export function useTradeLiveQuote(
  trade: LiveQuoteTrade | null,
  userId: string | undefined,
): TradeLiveQuoteState {
  const [state, setState] = useState<InternalState>(IDLE_INTERNAL)
  const poll = Boolean(userId && shouldPollTradeQuote(trade))

  const brokerId = poll ? trade!.broker_id : ''
  const symbol = poll ? trade!.symbol.trim() : ''
  const direction = poll ? trade!.direction : ''
  const tradeId = poll ? trade!.id : ''
  const wantKey = poll ? `${tradeId}|${symbol}` : null

  useEffect(() => {
    if (!poll) return

    let cancelled = false
    let inFlight = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const run = async () => {
      if (cancelled || inFlight) return
      if (typeof document !== 'undefined' && document.hidden) {
        schedule()
        return
      }
      inFlight = true
      try {
        if (!userId || !brokerId || !symbol || !wantKey) return
        const key = wantKey
        const provider = await resolveQuoteProvider(brokerId, userId)
        if (cancelled) return
        setState(prev => prev.key === key
          ? { ...prev, loading: true, error: null, key }
          : { key, quote: null, price: null, loading: true, error: null, updatedAt: null })
        const raw = await fxsocketBroker.quote(brokerId, symbol, provider)
        if (cancelled) return
        const quote = normalizeTradeQuote(raw)
        setState({
          key,
          quote,
          price: liveExitPrice(direction, quote),
          loading: false,
          error: quote ? null : 'Price unavailable',
          updatedAt: Date.now(),
        })
      } catch (e) {
        if (cancelled) return
        // Clear price on failure so the UI never freezes on a stale number.
        setState({
          key: wantKey,
          quote: null,
          price: null,
          loading: false,
          error: e instanceof Error ? e.message : 'Price unavailable',
          updatedAt: null,
        })
      } finally {
        inFlight = false
        if (!cancelled) schedule()
      }
    }

    const schedule = () => {
      if (cancelled) return
      timer = setTimeout(() => {
        timer = null
        void run()
      }, LIVE_QUOTE_POLL_MS)
    }

    void run()

    const onVisibility = () => {
      if (typeof document === 'undefined') return
      if (!document.hidden && !inFlight && !timer) void run()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
    // tradeId/brokerId/symbol/direction/wantKey are derived from the open trade identity.
  }, [poll, userId, tradeId, brokerId, symbol, direction, wantKey])

  if (!poll || state.key !== wantKey) {
    return poll ? { ...IDLE, loading: true } : IDLE
  }
  return state
}

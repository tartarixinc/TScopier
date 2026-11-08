import type { SupabaseClient } from '@supabase/supabase-js'
import { selectBrokerAccountColumns } from './brokerAccountSelect'
import type { MtTrade } from './fxsocketBroker'
import { filterMtTradesSinceConnect } from './tradesSinceConnect'
import type { BrokerAccount, Trade } from '../types/database'

/**
 * Read-side database fallback: our own `trades` table, shaped as `MtTrade`
 * so the Trades page can render it unchanged when the LIVE broker feed is
 * unreachable (vendor outage, edge failure, network).
 *
 * Only ever used on a live-read failure — never as a replacement for the
 * live read, and never written into the session cache (the cache holds live
 * payloads; mixing in stored rows would let a later successful poll show
 * stale data as fresh). What it can and cannot show:
 * - closed trades: full detail, including the closing price and the
 *   realized profit the worker now persists (see the closed-trade fill
 *   backfill) — this is the data the banner refers to as "your saved trade
 *   records";
 * - open trades: what the copier recorded when it opened them; the running
 *   floating P/L is only as fresh as the last worker write, so it can lag.
 *
 * Fields the `trades` table does not keep (swap, commission, comment,
 * magic, broker state) map to null — the page already renders those as
 * empty for live rows too.
 */

/** Columns the fallback needs, all client-safe. */
export const DB_TRADES_FALLBACK_SELECT = [
  'id',
  'symbol',
  'direction',
  'lot_size',
  'entry_price',
  'sl',
  'tp',
  'close_price',
  'profit',
  'opened_at',
  'closed_at',
  'status',
  'broker_account_id',
  'metaapi_order_id',
].join(',')

/**
 * Upper bound so an outage cannot turn into an unbounded read: the live
 * feed itself is unbounded (full history), but a fallback showing the
 * recent few thousand trades beats an empty page or a query that fails.
 */
export const DB_TRADES_FALLBACK_LIMIT = 2000

/** Upper bound for the fallback read itself — keeps the refresh loop moving. */
export const DB_TRADES_FALLBACK_TIMEOUT_MS = 15_000

/** One stored row → the shape every consumer of `MtTrade` already expects. */
export function mapDbTradesToMtTrades(
  rows: readonly Trade[],
  accounts: readonly BrokerAccount[],
): MtTrade[] {
  const accountById = new Map(accounts.map(account => [account.id, account]))
  return rows.map(row => {
    const account = row.broker_account_id ? accountById.get(row.broker_account_id) : undefined
    const direction = row.direction === 'buy' || row.direction === 'sell' ? row.direction : ''
    // Only terminal states render as closed; `pending` (resting limit/stop
    // orders) and any not-yet-terminal state display as open, matching the
    // app's own `status in ('open','pending')` reads of this table.
    const status = row.status === 'closed' || row.status === 'cancelled' ? 'closed' : 'open'
    return {
      id: row.id,
      broker_id: row.broker_account_id ?? '',
      broker_label: account?.label ?? '',
      broker_name: account?.broker_name ?? null,
      ticket: Number(row.metaapi_order_id) || 0,
      position_ticket: null,
      symbol: row.symbol,
      direction,
      type: direction === 'buy' ? 'Buy' : direction === 'sell' ? 'Sell' : '',
      lot_size: Number(row.lot_size) || 0,
      entry_price: row.entry_price ?? null,
      sl: row.sl ?? null,
      tp: row.tp ?? null,
      close_price: row.close_price ?? null,
      profit: row.profit ?? null,
      swap: null,
      commission: null,
      comment: null,
      magic: null,
      opened_at: row.opened_at ?? null,
      closed_at: row.closed_at ?? null,
      state: null,
      status,
    } satisfies MtTrade
  })
}

/**
 * Stored trades for a user, newest first, limited, since-connect filtered —
 * the same filters the live path applies, so the list does not jump when
 * the feed comes back. Throws on any query error so the caller can fall
 * through to the plain error message when even our own data is unavailable.
 */
export async function fetchTradesFromDatabase(
  client: SupabaseClient,
  userId: string,
): Promise<MtTrade[]> {
  // Bounded like the live path: a hung request must not keep the refresh
  // loop's in-flight guard stuck until the OS gives up on the socket.
  const timeoutSignal = AbortSignal.timeout(DB_TRADES_FALLBACK_TIMEOUT_MS)
  const [accountsRes, tradesRes] = await Promise.all([
    selectBrokerAccountColumns(columns =>
      client
        .from('broker_accounts')
        .select(columns)
        .eq('user_id', userId)
        .abortSignal(timeoutSignal),
    ),
    client
      .from('trades')
      .select(DB_TRADES_FALLBACK_SELECT)
      .eq('user_id', userId)
      .order('opened_at', { ascending: false })
      .limit(DB_TRADES_FALLBACK_LIMIT)
      .abortSignal(timeoutSignal),
  ])
  if (accountsRes.error) throw accountsRes.error
  if (tradesRes.error) throw tradesRes.error

  const accounts = (accountsRes.data ?? []) as unknown as BrokerAccount[]
  const rows = (tradesRes.data ?? []) as unknown as Trade[]
  return filterMtTradesSinceConnect(mapDbTradesToMtTrades(rows, accounts), accounts)
}

export type LiveFeedFailureRecovery = {
  /** The live read's error message — what the user sees if recovery fails. */
  reason: string
  /** True when live rows (from the session cache or last read) are on screen. */
  hasLiveRows: boolean
  /** Reads our own stored trades for this user. */
  readStoredTrades: () => Promise<MtTrade[]>
  /** Live rows stay on screen: stale but real; the banner explains the delay. */
  keepLiveRows: () => void
  /** Show stored rows instead of an empty page. */
  applyStoredTrades: (rows: MtTrade[]) => void
  /** Even our own data was unavailable: surface the original live error. */
  showReadError: (reason: string) => void
}

/**
 * What to show after a live feed read failed, kept out of the hook so the
 * decision is unit-testable:
 *
 * - live rows on screen  → keep them (never downgrade live data, never write
 *   anything to the session cache — it holds live reads only);
 * - otherwise            → read our own stored trades (each attempt, so a
 *   prolonged outage still refreshes as the worker keeps writing rows);
 * - stored read failed too → clear and show the live error.
 */
export async function recoverFromLiveFeedFailure(
  recovery: LiveFeedFailureRecovery,
): Promise<void> {
  if (recovery.hasLiveRows) {
    recovery.keepLiveRows()
    return
  }
  try {
    recovery.applyStoredTrades(await recovery.readStoredTrades())
  } catch (dbError) {
    console.warn('[trades] database fallback failed', dbError)
    recovery.showReadError(recovery.reason)
  }
}

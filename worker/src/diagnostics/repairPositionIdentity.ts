/**
 * READ-ONLY by default. Reports (and, with `--apply`, repairs) the stored broker
 * identity of open trades.
 *
 * Why: on MT5 the ticket returned by an order send and the ticket of the live
 * position differ. New fills capture the position identity automatically; rows
 * opened before that (or whose capture did not run) only hold the send ticket.
 * This diagnostic resolves each open row against the broker's live positions and:
 *   - reports MATCH (certain, by ticket) / AMBIGUOUS / MISSING / NO-LIVE-POSITIONS;
 *   - with `--apply`, writes `broker_position_ticket` where the resolution is
 *     certain (never a guess — attribute-only matches are not written);
 *   - dumps the raw ticket fields of the account's OrderHistory rows so we can
 *     confirm which ticket field the broker's history actually keys on (the open
 *     question behind "absent but not confirmed closed in history").
 *
 * It never sends, closes or modifies an order.
 *
 * Usage (needs the worker env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY + broker creds):
 *   cd worker
 *   npx ts-node -r dotenv/config src/diagnostics/repairPositionIdentity.ts --ids <id,id>
 *   npx ts-node -r dotenv/config src/diagnostics/repairPositionIdentity.ts --all-open
 *   npx ts-node -r dotenv/config src/diagnostics/repairPositionIdentity.ts --apply
 *   npx ts-node -r dotenv/config src/diagnostics/repairPositionIdentity.ts --history-for <brokerAccountId>
 *
 * Optional: `--json`, `--limit <n>`.
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { brokerRuntimeForAccount, loadBrokerApiByAccountId } from '../mtApiByAccount'
import { resolveCanonicalOpenPosition } from '../livePositionIdentity'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const HISTORY_DAYS = 30

type OpenRow = {
  id: string
  broker_account_id: string | null
  metaapi_order_id: string | null
  broker_position_ticket: string | null
  symbol: string | null
  direction: string | null
  lot_size: number | null
  entry_price: number | null
  status: string
}

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? (process.argv[i + 1] ?? null) : null
}

function mtDate(d: Date): string {
  return d.toISOString().slice(0, 19)
}

/** Every ticket-shaped value a broker row exposes. */
function ticketFields(row: Record<string, unknown>): Record<string, unknown> {
  const keys = [
    'ticket', 'Ticket',
    'orderTicket', 'OrderTicket', 'order', 'Order', 'orderId', 'OrderId',
    'dealTicket', 'DealTicket', 'deal', 'Deal',
    'positionTicket', 'PositionTicket', 'positionId', 'PositionId', 'position', 'Position',
    'dealInternalIn', 'DealInternalIn', 'dealInternalOut', 'DealInternalOut',
  ]
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    const value = row[key]
    if (value != null && typeof value !== 'object') out[key] = value
  }
  for (const nested of ['position', 'Position', 'dealInternalIn', 'DealInternalIn', 'dealInternalOut', 'DealInternalOut', 'order', 'Order']) {
    const value = row[nested]
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const inner = ticketFields(value as Record<string, unknown>)
      if (Object.keys(inner).length) out[nested] = inner
    }
  }
  return out
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  if (apply && !argValue('--ids') && !argValue('--account')) {
    console.error('--apply requires --ids <id,id> or --account <brokerAccountId> so the write is scoped')
    process.exit(1)
  }
  const asJson = process.argv.includes('--json')
  const allOpen = process.argv.includes('--all-open')
  const idsArg = argValue('--ids')
  const accountArg = argValue('--account')
  const historyFor = argValue('--history-for')
  const limit = Number(argValue('--limit') ?? 500)

  console.log('=== Position identity report' + (apply ? ' (APPLY)' : ' (read-only)') + ' ===\n')
  console.log('Supabase:', process.env.SUPABASE_URL?.replace(/https?:\/\//, '').split('/')[0], '\n')

  // History-only mode: dump the raw ticket fields for one account.
  if (historyFor) {
    const runtimes = await loadBrokerApiByAccountId(supabase, [historyFor])
    const runtime = brokerRuntimeForAccount(runtimes, historyFor)
    if (!runtime) { console.error('No runtime for account', historyFor); process.exit(1) }
    const to = mtDate(new Date())
    const from = mtDate(new Date(Date.now() - HISTORY_DAYS * 86_400_000))
    const rows = (await runtime.api.orderHistory(runtime.sessionId, from, to)) ?? []
    console.log(`OrderHistory rows: ${rows.length} (${from} → ${to})\n`)
    for (const raw of rows.slice(0, 40)) {
      if (!raw || typeof raw !== 'object') continue
      const row = raw as Record<string, unknown>
      console.log(JSON.stringify({
        tickets: ticketFields(row),
        symbol: row.symbol ?? row.Symbol,
        state: row.state ?? row.State,
        lots: row.lots ?? row.Lots,
        closeTime: row.closeTime ?? row.CloseTime,
        closePrice: row.closePrice ?? row.ClosePrice,
        profit: row.profit ?? row.Profit,
        comment: row.comment ?? row.Comment,
      }))
    }
    return
  }

  // Select the open rows to inspect.
  let query = supabase
    .from('trades')
    .select('id,broker_account_id,metaapi_order_id,broker_position_ticket,symbol,direction,lot_size,entry_price,status')
    .eq('status', 'open')
    .not('broker_account_id', 'is', null)
    .limit(limit)
  if (idsArg) query = query.in('id', idsArg.split(',').map(s => s.trim()).filter(Boolean))
  else if (accountArg) query = query.eq('broker_account_id', accountArg)
  else if (!allOpen) query = query.is('broker_position_ticket', null)

  const { data, error } = await query
  if (error) throw new Error(`trades select failed: ${error.message}`)
  const rows = (data ?? []) as OpenRow[]
  if (!rows.length) { console.log('No matching open trades.'); return }

  const byAccount = new Map<string, OpenRow[]>()
  for (const row of rows) {
    const key = row.broker_account_id!
    byAccount.set(key, [...(byAccount.get(key) ?? []), row])
  }

  const runtimes = await loadBrokerApiByAccountId(supabase, [...byAccount.keys()])

  let matched = 0
  let ambiguous = 0
  let missing = 0
  let noPositions = 0
  let written = 0
  const unresolved: Array<Record<string, unknown>> = []

  for (const [accountId, accountRows] of byAccount) {
    const runtime = brokerRuntimeForAccount(runtimes, accountId)
    if (!runtime) {
      console.log(`account ${accountId}: no runtime (paused/unavailable) — skipping ${accountRows.length} row(s)`)
      continue
    }
    let opened: unknown[] = []
    try {
      // The broker client is keyed by the *session* id, not the account id.
      opened = (await runtime.api.openedOrders(runtime.sessionId)) ?? []
    } catch (err) {
      console.log(`account ${accountId}: openedOrders failed: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    console.log(`account ${accountId}: ${accountRows.length} open row(s), ${opened.length} live position(s)`)

    for (const row of accountRows) {
      const resolution = resolveCanonicalOpenPosition({ trade: row, openedOrders: opened })
      if (resolution.status === 'resolved' && resolution.matchedBy !== 'attributes') {
        matched += 1
        const canonical = resolution.ticket
        const needsWrite = apply && row.broker_position_ticket == null
        if (needsWrite) {
          const { error: writeErr } = await supabase
            .from('trades')
            .update({
              broker_position_ticket: String(canonical),
              metaapi_order_id: String(canonical),
            })
            .eq('id', row.id)
            .is('broker_position_ticket', null)
          if (!writeErr) written += 1
          console.log(`  MATCH   ${row.id} stored=${row.metaapi_order_id} → position=${canonical}`
            + (writeErr ? ` (write failed: ${writeErr.message})` : needsWrite ? ' (written)' : ''))
        } else if (!asJson) {
          console.log(`  MATCH   ${row.id} stored=${row.metaapi_order_id} → position=${canonical}`)
        }
        continue
      }
      if (resolution.status === 'resolved') {
        ambiguous += 1
        unresolved.push({ id: row.id, account: accountId, verdict: 'attributes-only (not written)', reason: 'match is by attributes, not by ticket' })
      } else if (resolution.status === 'ambiguous') {
        ambiguous += 1
        unresolved.push({ id: row.id, account: accountId, verdict: 'ambiguous', reason: resolution.reason })
      } else {
        missing += 1
        unresolved.push({ id: row.id, account: accountId, verdict: 'missing (no live position)', reason: resolution.reason })
      }
    }
    if (!opened.length) noPositions += accountRows.length
  }

  console.log('\n=== summary ===')
  console.log(`matched by ticket : ${matched}`)
  console.log(`ambiguous         : ${ambiguous}`)
  console.log(`missing           : ${missing}`)
  console.log(`account was flat  : ${noPositions}`)
  if (apply) console.log(`broker_position_ticket written: ${written}`)
  if (unresolved.length) {
    console.log('\nunresolved rows (need closure or manual review):')
    for (const item of unresolved.slice(0, 50)) console.log(' ', JSON.stringify(item))
    console.log('\nTo see which ticket field the broker history keys on for one of these accounts:')
    console.log('  ... repairPositionIdentity.ts --history-for <brokerAccountId>')
  }
  if (asJson) console.log('\n' + JSON.stringify({ matched, ambiguous, missing, noPositions, written, unresolved }, null, 2))
}

main().catch(err => { console.error(err); process.exit(1) })

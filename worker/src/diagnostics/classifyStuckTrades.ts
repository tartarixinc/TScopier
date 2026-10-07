/**
 * READ-ONLY diagnostic: classify open trades (default: stuck auto-BE trades)
 * against live + closed broker state, so we know exactly what we are dealing
 * with before changing any state.
 *
 * It never writes to the DB, never sends/closes/modifies an order.
 *
 * Usage:
 *   cd worker && npx ts-node -r dotenv/config src/diagnostics/classifyStuckTrades.ts
 *   ... --ids <tradeId>,<tradeId>
 *   ... --all-open            # every status='open' trade, not just auto-BE ones
 *
 * Optional: `--json` prints the full machine-readable result too.
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { brokerRuntimeForAccount, loadBrokerApiByAccountId } from '../mtApiByAccount'
import { classifyOpenTrade, type ClassifyTradeRow, type OpenTradeClassification } from '../openTradeClassification'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

function mtDate(d: Date): string {
  return d.toISOString().slice(0, 19)
}

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? (process.argv[i + 1] ?? null) : null
}

async function main(): Promise<void> {
  console.log('=== Stuck-trade classification (READ-ONLY) ===\n')
  console.log('Supabase:', process.env.SUPABASE_URL?.replace(/https?:\/\//, '').split('/')[0])

  const idsArg = argValue('--ids')
  const allOpen = process.argv.includes('--all-open')

  let query = supabase
    .from('trades')
    .select('id,signal_id,broker_account_id,metaapi_order_id,symbol,direction,lot_size,entry_price,status,auto_be_mode,auto_be_applied_at,opened_at')
    .eq('status', 'open')
    .limit(500)

  if (idsArg) {
    const ids = idsArg.split(',').map(s => s.trim()).filter(Boolean)
    query = query.in('id', ids)
  } else if (!allOpen) {
    query = query.not('auto_be_mode', 'is', null).is('auto_be_applied_at', null)
  }

  const { data, error } = await query
  if (error) throw new Error(`trades select failed: ${error.message}`)
  const trades = (data ?? []) as (ClassifyTradeRow & { auto_be_mode?: string | null })[]
  if (!trades.length) {
    console.log('No matching open trades. Nothing to classify.')
    return
  }
  console.log(`Open trades selected: ${trades.length}\n`)

  const byBroker = new Map<string, ClassifyTradeRow[]>()
  const withoutBroker: ClassifyTradeRow[] = []
  for (const t of trades) {
    const id = String(t.broker_account_id ?? '').trim()
    if (!id) { withoutBroker.push(t); continue }
    byBroker.set(id, [...(byBroker.get(id) ?? []), t])
  }

  const results: OpenTradeClassification[] = []
  for (const t of withoutBroker) {
    results.push({ id: t.id, status: 'unknown', reason: 'trade has no broker_account_id' })
  }

  const runtimeByBroker = await loadBrokerApiByAccountId(supabase, [...byBroker.keys()])
  const to = mtDate(new Date())
  const from = mtDate(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))

  for (const [brokerId, brokerTrades] of byBroker) {
    const runtime = brokerRuntimeForAccount(runtimeByBroker, brokerId)
    if (!runtime) {
      for (const t of brokerTrades) {
        results.push({ id: t.id, status: 'unknown', reason: 'no stable broker runtime/session' })
      }
      continue
    }
    const { api, sessionId } = runtime
    console.log(`--- account ${brokerId.slice(0, 8)}  session ${sessionId.slice(0, 8)}  trades=${brokerTrades.length}`)

    let openedHealthy = false
    try {
      await api.checkConnect(sessionId)
      openedHealthy = true
    } catch (err) {
      console.log(`    ! checkConnect failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    let openedOrders: unknown[] = []
    try {
      openedOrders = (await api.openedOrders(sessionId)) ?? []
      console.log(`    open positions returned: ${openedOrders.length}`)
      const sample = openedOrders[0]
      if (sample && typeof sample === 'object') {
        console.log(`    open-position fields: ${Object.keys(sample as Record<string, unknown>).slice(0, 25).join(', ')}`)
      }
    } catch (err) {
      console.log(`    ! openedOrders failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    let closedOrders: unknown[] = []
    try {
      closedOrders = (await api.orderHistory(sessionId, from, to)) ?? []
      console.log(`    history rows (${from}..${to}): ${closedOrders.length}`)
    } catch (err) {
      console.log(`    ! orderHistory failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    // Sample the comments present on live positions so we can see whether the
    // order comment is a usable deterministic key.
    const comments = openedOrders
      .map(r => (r && typeof r === 'object' ? (r as Record<string, unknown>).comment : null))
      .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
    if (comments.length) console.log(`    sample live comments: ${[...new Set(comments.slice(0, 8))].join(' | ')}`)

    for (const trade of brokerTrades) {
      const result = classifyOpenTrade({ trade, openedOrders, closedOrders, openedHealthy })
      results.push(result)
      const base = `    ${trade.id.slice(0, 8)} ${String(trade.symbol ?? '?').padEnd(9)} ${String(trade.direction ?? '?').padEnd(4)} lot=${trade.lot_size ?? '?'} entry=${trade.entry_price ?? '?'} ticket=${trade.metaapi_order_id ?? 'none'}`
      const detail = result.status === 'live'
        ? `LIVE by ${result.matchedBy}${result.comment ? ` comment=${result.comment}` : ''}`
        : result.status === 'ambiguous'
          ? `AMBIGUOUS: ${result.reason}`
          : result.status === 'closed'
            ? `CLOSED by ${result.matchedBy} closePrice=${result.closePrice ?? '?'} closeTime=${result.closeTime ?? '?'}`
            : result.status === 'missing'
              ? 'MISSING (not live, not in history)'
              : `UNKNOWN: ${result.reason}`
      console.log(`${base} -> ${detail}`)
    }
    console.log('')
  }

  const tally = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1
    return acc
  }, {})
  console.log('=== Summary ===')
  console.log(JSON.stringify(tally, null, 2))
  if (process.argv.includes('--json')) {
    console.log('\n=== JSON ===')
    console.log(JSON.stringify(results, null, 2))
  }
}

main().catch(err => {
  console.error('diagnostic failed:', err instanceof Error ? err.stack ?? err.message : err)
  process.exitCode = 1
})

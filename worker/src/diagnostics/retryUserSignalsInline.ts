/**
 * Retry failed entry signals in-process (no worker HTTP needed).
 * Usage: npx ts-node -r dotenv/config src/diagnostics/retryUserSignalsInline.ts <user_id> <signal_id> [...]
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { UserSessionManager } from '../sessionManager'
import { TradeExecutor } from '../tradeExecutor'
import { retrySignal } from '../retrySignal'
import { FxsocketBrokerClient } from '../fxsocketClient'
import {
  createSupabaseBrokerWriteAuthorityStore,
  registerBrokerWriteAuthorityStore,
} from '../brokerWriteAuthority'
import { listFxsocketMtStatusChecks } from '../fxsocketMtStatus'

async function main() {
  const userId = process.argv[2]?.trim()
  const signalIds = process.argv.slice(3).map(s => s.trim()).filter(Boolean)
  if (!userId || signalIds.length === 0) {
    console.error('usage: retryUserSignalsInline.ts <user_id> <signal_id> [signal_id...]')
    process.exit(1)
  }

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
  registerBrokerWriteAuthorityStore(createSupabaseBrokerWriteAuthorityStore(supabase))

  const { data: broker } = await supabase
    .from('broker_accounts')
    .select('fxsocket_account_id')
    .eq('user_id', userId)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle()

  const fxsId = broker?.fxsocket_account_id as string | null | undefined
  if (fxsId) {
    try {
      const client = new FxsocketBrokerClient('MT5')
      const status = await client.mtStatus(fxsId, 'MT5')
      const failing = listFxsocketMtStatusChecks(status).filter(c => !c.ok).map(c => c.id)
      console.log(JSON.stringify({ preflight: { status: status.status, tradeEaReady: status.bridge?.tradeEaReady, failing } }))
    } catch (e) {
      console.warn('preflight mtStatus failed:', e instanceof Error ? e.message : e)
    }
  }

  const sessionManager = new UserSessionManager(supabase)
  const executor = new TradeExecutor(supabase, sessionManager)
  await executor.start()

  try {
    for (const signalId of signalIds) {
      const result = await retrySignal(executor, { userId, signalId })
      console.log(JSON.stringify({ signalId, result }))
    }
  } finally {
    executor.stop()
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})

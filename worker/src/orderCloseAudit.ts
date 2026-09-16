/**
 * Central OrderClose audit — every broker close must leave a console + optional
 * DB trail so silent mass-closes can be attributed to a call stack.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export type OrderCloseAuditEvent = {
  source: 'fxsocket' | 'fx_v2'
  accountId: string
  ticket: number
  volume?: number | null
  slippage?: number | null
  ok?: boolean
  message?: string | null
}

type AuditSink = (event: OrderCloseAuditEvent & { stack: string }) => void

let sink: AuditSink | null = null
const accountByFxAccount = new Map<string, { userId: string; brokerAccountId: string }>()

/** Register from worker boot so closes can persist to trade_execution_logs. */
export function registerOrderCloseAuditSink(next: AuditSink | null): void {
  sink = next
}

export function registerOrderCloseAuditSupabase(supabase: SupabaseClient): void {
  registerOrderCloseAuditSink((event) => {
    void (async () => {
      // The audit event only carries the FxSocket account id + ticket, but
      // trade_execution_logs requires user_id (NOT NULL) and signal_id (NOT
      // NULL). Resolve user_id + broker_account id from broker_accounts
      // (fxsocket_account_id), then signal_id from the owning trades row
      // (broker_account_id + metaapi order id). Both are required — if either
      // cannot be resolved the DB write is skipped (console trail remains).
      let account = accountByFxAccount.get(event.accountId)
      if (!account) {
        const { data } = await supabase
          .from('broker_accounts')
          .select('id, user_id')
          .eq('fxsocket_account_id', event.accountId)
          .maybeSingle()
        const row = data as { id?: string; user_id?: string } | null
        if (row?.id && row?.user_id) {
          account = { brokerAccountId: row.id, userId: row.user_id }
          accountByFxAccount.set(event.accountId, account)
        }
      }
      if (!account) {
        console.warn(
          `[orderCloseAudit] skip persist — no broker_account for fx account=${event.accountId}`,
        )
        return
      }
      const { data: trade } = await supabase
        .from('trades')
        .select('signal_id')
        .eq('broker_account_id', account.brokerAccountId)
        .eq('metaapi_order_id', String(event.ticket))
        .maybeSingle()
      const signalId = ((trade as { signal_id?: string | null } | null)?.signal_id) ?? null
      if (!signalId) {
        console.warn(
          `[orderCloseAudit] skip persist — no trade row for account=${event.accountId} ticket=${event.ticket}; audit not persisted`,
        )
        return
      }
      const { error } = await supabase.from('trade_execution_logs').insert({
        user_id: account.userId,
        signal_id: signalId,
        action: 'order_close_audit',
        status: event.ok === false ? 'failed' : 'success',
        request_payload: {
          source: event.source,
          account_id: event.accountId,
          ticket: event.ticket,
          volume: event.volume ?? null,
          slippage: event.slippage ?? null,
          message: event.message ?? null,
          stack: event.stack.slice(0, 4000),
        } as unknown as Record<string, unknown>,
        error_message: event.ok === false ? (event.message ?? 'orderClose failed') : null,
      })
      if (error) {
        console.warn(`[orderCloseAudit] persist failed: ${error.message}`)
      }
    })()
  })
}

/** Always log; optionally persist via registered sink. */
export function auditOrderClose(event: OrderCloseAuditEvent): void {
  const stack = (new Error('orderClose').stack ?? '').split('\n').slice(2, 18).join('\n')
  console.warn(
    `[orderCloseAudit] source=${event.source} account=${event.accountId}`
      + ` ticket=${event.ticket} volume=${event.volume ?? 'full'}`
      + ` ok=${event.ok ?? 'pending'}`
      + (event.message ? ` msg=${event.message}` : '')
      + `\n${stack}`,
  )
  try {
    sink?.({ ...event, stack })
  } catch (err) {
    console.warn(`[orderCloseAudit] sink error: ${(err as Error).message}`)
  }
}

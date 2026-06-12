import type { SupabaseClient } from '@supabase/supabase-js'
import { incMetric } from './workerMetrics'

export type ListenerEventType =
  | 'unmapped_channel'
  | 'poll_error'
  | 'peer_resolve_failed'
  | 'poll_peer_resolve_failed'
  | 'catchup_get_messages_failed'
  | 'ai_modification_parsed'
  | 'ai_modification_skipped'
  | 'ai_modification_failed'
  | 'message_revision_applied'
  | 'entry_settle_poll_mismatch'
  | 'entry_settle_poll_applied'
  | 'teaser_completion_merge_applied'
  | 'signal_reconcile_mismatch'
  | 'signal_reconcile_sweep_error'
  | 'signal_reconcile_checked'

export async function persistListenerEvent(
  supabase: SupabaseClient,
  args: {
    userId: string
    eventType: ListenerEventType
    channelRowId?: string | null
    telegramMessageId?: string | null
    detail?: Record<string, unknown>
  },
): Promise<void> {
  incMetric(`listener_event_${args.eventType}`)
  const { error } = await supabase.from('listener_events').insert({
    user_id: args.userId,
    channel_row_id: args.channelRowId ?? null,
    telegram_message_id: args.telegramMessageId ?? null,
    event_type: args.eventType,
    detail: args.detail ?? {},
  })
  if (error) {
    console.warn(
      `[listenerEvents] insert failed type=${args.eventType} user=${args.userId}:`,
      error.message,
    )
  }
}

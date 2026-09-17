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
  | 'ai_entry_parsed'
  | 'ai_entry_skipped'
  | 'ai_parse_fallback'
  | 'ai_parse_review_required'
  | 'message_revision_applied'
  | 'message_revision_stale_skipped'
  | 'message_revision_dispatch_deduped'
  | 'entry_settle_poll_mismatch'
  | 'entry_settle_poll_applied'
  | 'teaser_completion_merge_applied'
  | 'signal_reconcile_mismatch'
  | 'signal_reconcile_parsed_drift'
  | 'signal_reconcile_sweep_error'
  | 'signal_reconcile_checked'
  | 'channel_shadow_mismatch'
  | 'channel_reconcile_mismatch'
  | 'channel_invalid_detected'
  | 'channel_auto_disabled'
  | 'channel_reactivated'
  | 'poll_flood_backoff'
  | 'telegram_link_attempt'
  | 'telegram_link_success'
  | 'telegram_link_failed'

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

/** Fire-and-forget: log a Telegram auth failure to listener_events. */
export function logTelegramAuthFailure(
  supabase: SupabaseClient,
  userId: string,
  step: string,
  error: string,
): void {
  void persistListenerEvent(supabase, {
    userId,
    eventType: 'telegram_link_failed',
    detail: { step, error },
  })
}

/** Fire-and-forget: log a Telegram auth success to listener_events. */
export function logTelegramAuthSuccess(
  supabase: SupabaseClient,
  userId: string,
  sessionId: string,
): void {
  void persistListenerEvent(supabase, {
    userId,
    eventType: 'telegram_link_success',
    detail: { session_id: sessionId },
  })
}

/**
 * One getMessages reconcile pass per signal_channel (elected reader session).
 * Mgmt signals fan out via channelSignalProjector after reconcile detects edits.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { TelegramClient } from 'telegram'
import { channelListenerModeEnabled, recordSignalChannelMetric } from './channelListenerConfig'
import { fetchChannelLeaseReader } from './channelListenerLease'
import { signalChannelBelongsToShard } from './channelReaderRegistry'
import { incMetric } from './workerMetrics'
import { persistListenerEvent } from './listenerEvents'
import { telegramMessageText } from './signalTelegramReconcile'
import type { MonitorLoopHandle } from './monitorIdleGate'

const TICK_MS = Math.max(
  15_000,
  Math.min(120_000, Number(process.env.CHANNEL_RECONCILE_TICK_MS ?? 45_000)),
)

export type ChannelClientResolver = (
  readerUserId: string,
  signalChannelId: string,
  telegramChatId: string,
) => Promise<{ client: TelegramClient; resolvePeer: () => Promise<unknown> } | null>

export class ChannelReconcileMonitor {
  private timer: ReturnType<typeof setInterval> | null = null
  private inFlight = false

  constructor(
    private supabase: SupabaseClient,
    private resolveClient: ChannelClientResolver,
  ) {}

  start(): void {
    if (!channelListenerModeEnabled()) return
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick()
    }, TICK_MS)
    this.timer.unref?.()
    console.log(`[channelReconcileMonitor] started tickMs=${TICK_MS}`)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  getLoopHandle(): MonitorLoopHandle {
    return {
      stop: () => this.stop(),
      poke: () => { void this.tick() },
    }
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return
    this.inFlight = true
    try {
      const { data: channels } = await this.supabase
        .from('signal_channels')
        .select('id, telegram_chat_id, subscriber_count')
        .gt('subscriber_count', 0)

      for (const row of channels ?? []) {
        const ch = row as { id: string; telegram_chat_id: string; subscriber_count: number }
        if (!signalChannelBelongsToShard(ch.id)) continue

        const reader = await fetchChannelLeaseReader(this.supabase, ch.id)
        if (!reader) continue

        await this.reconcileChannel(ch.id, ch.telegram_chat_id, reader).catch(err => {
          console.warn(
            `[channelReconcileMonitor] reconcile failed signalChannel=${ch.id}:`,
            err instanceof Error ? err.message : err,
          )
        })
      }
    } finally {
      this.inFlight = false
    }
  }

  private async reconcileChannel(
    signalChannelId: string,
    telegramChatId: string,
    readerUserId: string,
  ): Promise<void> {
    const resolved = await this.resolveClient(readerUserId, signalChannelId, telegramChatId)
    if (!resolved) return

    const peer = await resolved.resolvePeer()
    let batch: Array<{ id: number | bigint; text?: string | null; message?: string | null }>
    try {
      batch = (await resolved.client.getMessages(peer as never, { limit: 15 })) as typeof batch
    } catch (err) {
      incMetric('channel_reconcile_get_messages_failed')
      return
    }

    if (!batch.length) return

    const { data: recentSignals } = await this.supabase
      .from('channel_signals')
      .select('telegram_message_id, raw_message, status')
      .eq('signal_channel_id', signalChannelId)
      .order('created_at', { ascending: false })
      .limit(30)

    const byMsgId = new Map(
      (recentSignals ?? []).map(r => [
        String((r as { telegram_message_id: string }).telegram_message_id),
        r as { raw_message: string; status: string },
      ]),
    )

    let mismatches = 0
    for (const msg of batch) {
      const msgId = String(msg.id)
      const liveText = telegramMessageText(msg)
      const stored = byMsgId.get(msgId)
      if (!stored) continue
      if (stored.raw_message.trim() === liveText.trim()) continue

      mismatches++
      recordSignalChannelMetric(signalChannelId, 'channel_reconcile_mismatch')
      void persistListenerEvent(this.supabase, {
        userId: readerUserId,
        eventType: 'channel_reconcile_mismatch',
        telegramMessageId: msgId,
        detail: {
          signal_channel_id: signalChannelId,
          stored_len: stored.raw_message.length,
          live_len: liveText.length,
        },
      })

      await this.supabase
        .from('channel_messages')
        .upsert(
          {
            signal_channel_id: signalChannelId,
            telegram_message_id: msgId,
            raw_message: liveText,
            received_at: new Date().toISOString(),
          },
          { onConflict: 'signal_channel_id,telegram_message_id' },
        )
    }

    if (mismatches > 0) {
      incMetric('channel_reconcile_mismatch', mismatches)
      console.log(
        `[channelReconcileMonitor] signalChannel=${signalChannelId} mismatches=${mismatches}`,
      )
    } else {
      incMetric('channel_reconcile_checked')
    }
  }
}

/** Batch fan-out hint for management: all active subscriptions on a signal_channel. */
export async function loadMgmtFanOutSubscriptions(
  supabase: SupabaseClient,
  signalChannelId: string,
): Promise<Array<{ subscriptionId: string; userId: string }>> {
  const { data } = await supabase
    .from('telegram_channels')
    .select('id, user_id')
    .eq('signal_channel_id', signalChannelId)
    .eq('is_active', true)

  return (data ?? []).map(r => ({
    subscriptionId: (r as { id: string }).id,
    userId: (r as { user_id: string }).user_id,
  }))
}

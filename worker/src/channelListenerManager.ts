/**
 * Channel listener manager — WORKER_ROLE=channel_listener coordination.
 * Telethon alignment: set LISTENER_ENGINE=telethon on telethon service; both
 * engines use the same signal_channels registry + channel_listener_leases protocol.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { backfillUnlinkedSubscriptions } from './channelRegistry'
import {
  channelListenerModeEnabled,
  recordSignalChannelMetric,
} from './channelListenerConfig'
import {
  listEnrolledSignalChannels,
  renewChannelLeasesForReader,
  syncChannelReaders,
} from './channelReaderRegistry'
import { workerConfig } from './workerConfig'

export class ChannelListenerManager {
  private syncTimer: ReturnType<typeof setInterval> | null = null

  constructor(private supabase: SupabaseClient) {}

  async startup(): Promise<void> {
    if (!this.shouldRun()) return

    const linked = await backfillUnlinkedSubscriptions(this.supabase)
    if (linked > 0) {
      console.log(`[channelListenerManager] backfilled ${linked} unlinked subscriptions`)
    }

    const { elected, total } = await syncChannelReaders(this.supabase)
    console.log(
      `[channelListenerManager] startup enrolled=${total} newlyElected=${elected}`
      + ` mode=${process.env.CHANNEL_LISTENER_MODE ?? 'off'}`,
    )
  }

  startPeriodicSync(): void {
    if (!this.shouldRun()) return
    if (this.syncTimer) return

    const intervalMs = Math.max(
      15_000,
      Math.min(120_000, Number(process.env.CHANNEL_LISTENER_SYNC_MS ?? 30_000)),
    )

    this.syncTimer = setInterval(() => {
      void this.syncCycle()
    }, intervalMs)
    this.syncTimer.unref?.()
  }

  stop(): void {
    if (this.syncTimer) clearInterval(this.syncTimer)
    this.syncTimer = null
  }

  private shouldRun(): boolean {
    if (!channelListenerModeEnabled()) return false
    return workerConfig.runsChannelListener || workerConfig.runsListener
  }

  private async syncCycle(): Promise<void> {
    await syncChannelReaders(this.supabase)

    const channels = await listEnrolledSignalChannels(this.supabase)
    for (const ch of channels) {
      recordSignalChannelMetric(ch.signalChannelId, 'channel_listener_sync')
      if (ch.readerUserId) {
        await renewChannelLeasesForReader(this.supabase, ch.readerUserId)
      }
    }
  }
}

/** Telethon service hook: same registry protocol documented for Python listener. */
export const TELETHON_CHANNEL_LISTENER_NOTES = `
Telethon alignment (telegram-listener/):
- Upsert signal_channels on channel discovery (telegram_chat_id canonical -100… form)
- Acquire channel_listener_leases via elected subscriber session
- Write channel_messages + channel_signals on ingest
- Honor CHANNEL_LISTENER_MODE (off/shadow/primary) and CHANNEL_LISTENER_ALLOWLIST
- Passive subscribers skip poll when canonical feed is live (primary mode)
`.trim()

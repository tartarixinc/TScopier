import type { SupabaseClient } from '@supabase/supabase-js'
import {
  copyLimitsActive,
  evaluateCopyLimitBreaches,
  mergeBreachesIntoState,
  periodEquitySnapshot,
  reconcilePausedKeysWithConfig,
  resolveCopyLimitTimezone,
  updatePeriodSnapshots,
} from './copyLimitEvaluate'
import {
  buildChannelPnlSnapshot,
  fetchLiveAccountEquity,
  resolveReferenceEquity,
} from './copyLimitMetrics'
import type { CopyLimitPeriod } from './copyLimitTypes'
import { flattenChannelTradesForCopyLimit } from './copyLimitFlatten'
import { normalizeCopyLimitState, normalizeCopyLimits } from './copyLimitTypes'
import { normalizeChannelUuid } from './channelTradingConfig'
import { isUserCopierPausedCached } from './copierPause'

const TICK_MS = 30_000

interface BrokerAccountRow {
  id: string
  user_id: string
  metaapi_account_id: string
  platform: string
  last_balance: number | null
  last_equity: number | null
  is_active: boolean
}

interface ChannelConfigRow {
  broker_account_id: string
  channel_id: string
  manual_settings: Record<string, unknown>
  copy_limit_state: Record<string, unknown> | null
}

export class CopyLimitMonitor {
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  private userTimezoneCache = new Map<string, string>()

  constructor(private readonly supabase: SupabaseClient) {}

  start() {
    if (this.timer) return
    this.timer = setInterval(() => {
      if (this.ticking) return
      this.ticking = true
      this.tick()
        .catch(err => {
          console.error('[copyLimitMonitor] tick error:', err instanceof Error ? err.message : String(err))
        })
        .finally(() => { this.ticking = false })
    }, TICK_MS)
    this.timer.unref?.()
    console.log(`[copyLimitMonitor] started (interval=${TICK_MS}ms)`)
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async resolveUserTimezone(userId: string): Promise<string> {
    const cached = this.userTimezoneCache.get(userId)
    if (cached) return cached
    const { data } = await this.supabase
      .from('user_profiles')
      .select('timezone')
      .eq('user_id', userId)
      .maybeSingle()
    const tz = String((data as { timezone?: string } | null)?.timezone ?? 'UTC').trim() || 'UTC'
    this.userTimezoneCache.set(userId, tz)
    return tz
  }

  private async tick(): Promise<void> {
    const { data: configRows, error } = await this.supabase
      .from('broker_channel_trading_configs')
      .select('broker_account_id,channel_id,manual_settings,copy_limit_state')

    if (error) {
      console.error('[copyLimitMonitor] config select failed:', error.message)
      return
    }

    const rows = (configRows ?? []) as ChannelConfigRow[]
    const activeRows = rows.filter(row => {
      const limits = normalizeCopyLimits(row.manual_settings?.copy_limits)
      return copyLimitsActive(limits)
    })
    if (!activeRows.length) return

    const brokerIds = [...new Set(activeRows.map(r => r.broker_account_id))]
    const { data: brokers, error: brokerErr } = await this.supabase
      .from('broker_accounts')
      .select('id,user_id,metaapi_account_id,platform,last_balance,last_equity,is_active')
      .in('id', brokerIds)
      .eq('is_active', true)

    if (brokerErr) {
      console.error('[copyLimitMonitor] broker select failed:', brokerErr.message)
      return
    }

    const brokerById = new Map(
      ((brokers ?? []) as BrokerAccountRow[]).map(b => [b.id, b]),
    )

    for (const row of activeRows) {
      const broker = brokerById.get(row.broker_account_id)
      if (!broker?.metaapi_account_id) continue
      if (isUserCopierPausedCached(broker.user_id)) continue

      const channelId = normalizeChannelUuid(row.channel_id)
      if (!channelId) continue

      const config = normalizeCopyLimits(row.manual_settings?.copy_limits)
      const profileTz = await this.resolveUserTimezone(broker.user_id)
      const timeZone = resolveCopyLimitTimezone(config, profileTz)
      const fallbackEquity = resolveReferenceEquity(broker.last_equity, broker.last_balance)
      if (fallbackEquity <= 0) continue

      const currentEquity = await fetchLiveAccountEquity(
        broker.metaapi_account_id,
        broker.platform,
        fallbackEquity,
        { lastBalance: broker.last_balance },
      )
      if (currentEquity <= 0) continue

      let state = normalizeCopyLimitState(row.copy_limit_state)
      state = updatePeriodSnapshots({
        state,
        config,
        currentEquity,
        timeZone,
      })

      const breaches = []
      for (const period of new Set([
        ...config.profit_targets.filter(t => t.enabled).map(t => t.period),
        ...(config.max_risk_enabled
          ? config.max_risks.filter(r => r.enabled).map(r => r.period)
          : []),
      ] as CopyLimitPeriod[])) {
        const equity = periodEquitySnapshot(state, period, currentEquity, timeZone)
        const periodMaxRisks = config.max_risks.filter(r => r.enabled && r.period === period)
        const subset = {
          ...config,
          profit_targets: config.profit_targets.filter(t => t.enabled && t.period === period),
          max_risk_enabled: config.max_risk_enabled && periodMaxRisks.length > 0,
          max_risks: periodMaxRisks,
        }
        // Channel-scoped P/L (realized + live floating) as a secondary trigger —
        // fires the limit even when the account-equity delta lags or is skewed.
        const channelSnapshot = await buildChannelPnlSnapshot({
          supabase: this.supabase,
          brokerAccountId: broker.id,
          channelId,
          metaapiAccountId: broker.metaapi_account_id,
          platform: broker.platform,
          period,
          timeZone,
        })
        breaches.push(...evaluateCopyLimitBreaches({
          config: subset,
          state,
          equity,
          timeZone,
          channelPnl: channelSnapshot.totalPnl,
        }))
      }

      // Drop pauses whose rule was edited/removed since the breach (e.g. the
      // user raised the profit target); still-breaching rules are re-added
      // below with their current fingerprint.
      state = reconcilePausedKeysWithConfig(
        state,
        config,
        new Set(breaches.map(b => b.pauseKey)),
      )

      if (breaches.length) {
        const prevPaused = new Set(state.paused_period_keys)
        const flattened = new Set(state.flattened_pause_keys ?? [])
        const newlyPaused = breaches.filter(b => !prevPaused.has(b.pauseKey))
        state = mergeBreachesIntoState(state, breaches)

        const shouldFlatten = newlyPaused.some(b => !flattened.has(b.pauseKey))
        if (shouldFlatten) {
          const flattenReason = newlyPaused[0]!.reason
          await flattenChannelTradesForCopyLimit({
            supabase: this.supabase,
            userId: broker.user_id,
            brokerAccountId: broker.id,
            metaapiAccountId: broker.metaapi_account_id,
            platform: broker.platform,
            channelId,
            reason: flattenReason,
          })
          state = {
            ...state,
            flattened_pause_keys: [
              ...new Set([
                ...(state.flattened_pause_keys ?? []),
                ...newlyPaused.map(b => b.pauseKey),
              ]),
            ],
          }
        }

        console.log(
          `[copyLimitMonitor] limit hit broker=${broker.id} channel=${channelId}`
          + ` equity=${currentEquity.toFixed(2)}`
          + ` breaches=${breaches.map(b => b.pauseKey).join(',')}`
          + ` flattened=${shouldFlatten}`,
        )
      }

      const { error: updErr } = await this.supabase
        .from('broker_channel_trading_configs')
        .update({ copy_limit_state: state })
        .eq('broker_account_id', row.broker_account_id)
        .eq('channel_id', row.channel_id)

      if (updErr) {
        console.warn(`[copyLimitMonitor] state update failed: ${updErr.message}`)
      }
    }
  }
}

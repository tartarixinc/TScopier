import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeManualSettingsForExecution } from './manualPlanning/normalizeManualSettings'
import type { ManualSettings } from './manualPlanning/types'
import { normalizeSignalChannelIds } from './brokerChannelFilter'
import { normalizeCopyLimitState, type CopyLimitState } from './copyLimitTypes'
import { resolveBrokerTotalBalance } from './effectiveBrokerBalance'
import { stableStringify } from './stableJson'

export interface ChannelTradingConfig {
  copier_mode?: 'ai' | 'manual'
  manual_settings?: ManualSettings | Record<string, unknown> | null
  ai_settings?: Record<string, unknown> | null
  copy_limit_state?: CopyLimitState
}

export type ChannelTradingConfigsMap = Record<string, ChannelTradingConfig>

export type BrokerChannelTradingFields = {
  copier_mode?: 'ai' | 'manual' | string | null
  manual_settings?: Record<string, unknown> | null
  ai_settings?: Record<string, unknown> | null
  channel_trading_configs?: unknown
  signal_channel_ids?: string[] | null
  last_balance?: number | null
  last_equity?: number | null
}

function brokerAccountBalance(broker: BrokerChannelTradingFields): number | null {
  const bal = resolveBrokerTotalBalance(broker) ?? 0
  return bal > 0 ? bal : null
}

export type ChannelConfigSource = 'per_channel' | 'broker_fallback' | 'unlinked'

export type ChannelConfigReadyResult =
  | { ready: true; source: ChannelConfigSource }
  | { ready: false; reason: 'channel_config_missing' | 'channel_config_incomplete'; channelId: string }

export function normalizeChannelUuid(id: string | null | undefined): string | null {
  const s = String(id ?? '').trim()
  return s ? s.toLowerCase() : null
}

export function normalizeChannelTradingConfigsMap(raw: unknown): ChannelTradingConfigsMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: ChannelTradingConfigsMap = {}
  for (const [channelId, value] of Object.entries(raw as Record<string, unknown>)) {
    const key = normalizeChannelUuid(channelId)
    if (!key || !value || typeof value !== 'object' || Array.isArray(value)) continue
    const row = value as Record<string, unknown>
    const mode = row.copier_mode
    out[key] = {
      copier_mode: mode === 'ai' || mode === 'manual' ? mode : undefined,
      manual_settings: row.manual_settings && typeof row.manual_settings === 'object'
        ? (row.manual_settings as Record<string, unknown>)
        : undefined,
      ai_settings: row.ai_settings && typeof row.ai_settings === 'object'
        ? (row.ai_settings as Record<string, unknown>)
        : undefined,
      copy_limit_state: row.copy_limit_state && typeof row.copy_limit_state === 'object'
        ? normalizeCopyLimitState(row.copy_limit_state)
        : undefined,
    }
  }
  return out
}

export function resolveChannelConfigEntry(
  configs: ChannelTradingConfigsMap,
  channelId: string | null | undefined,
): ChannelTradingConfig | undefined {
  const key = normalizeChannelUuid(channelId)
  if (!key) return undefined
  if (configs[key]) return configs[key]
  for (const [k, v] of Object.entries(configs)) {
    if (k.toLowerCase() === key) return v
  }
  return undefined
}

function mergeHealedChannelManualSettings(
  existing: Record<string, unknown> | null | undefined,
  brokerFallback: Record<string, unknown>,
  defaultManual: Record<string, unknown>,
  accountBalance: number | null,
): Record<string, unknown> {
  const base = channelManualSettingsComplete(brokerFallback) ? brokerFallback : defaultManual
  const partial = existing && typeof existing === 'object' && !Array.isArray(existing)
    && !isMinimalSeedManualSettings(existing)
    ? existing
    : {}
  return normalizeManualSettingsForExecution({
    ...base,
    ...partial,
  }, { accountBalance }) as Record<string, unknown>
}

export function healChannelTradingConfigsMap(
  broker: BrokerChannelTradingFields,
): ChannelTradingConfigsMap {
  const configs = { ...normalizeChannelTradingConfigsMap(broker.channel_trading_configs) }
  const linkedIds = normalizeSignalChannelIds(broker.signal_channel_ids)
  const multiChannel = linkedIds.length > 1
  const balance = brokerAccountBalance(broker)
  const brokerFallbackManual = normalizeManualSettingsForExecution(broker.manual_settings, { accountBalance: balance }) as Record<string, unknown>
  const defaultManual = normalizeManualSettingsForExecution(
    buildDefaultChannelTradingConfig().manual_settings,
  ) as Record<string, unknown>
  const fallbackMode = (broker.copier_mode ?? 'manual') as 'ai' | 'manual'
  // broker.manual_settings mirrors the last channel saved in Account Configuration —
  // never use it to heal other linked channels or lot/style bleed across providers.
  const healBrokerFallback = multiChannel ? defaultManual : brokerFallbackManual

  for (const channelId of linkedIds) {
    const key = normalizeChannelUuid(channelId)
    if (!key) continue
    if (storedPerChannelConfigComplete(configs, key)) continue

    const existing = resolveChannelConfigEntry(configs, key)
    const manual = mergeHealedChannelManualSettings(
      existing?.manual_settings as Record<string, unknown> | undefined,
      healBrokerFallback,
      defaultManual,
      balance,
    )
    if (!channelManualSettingsComplete(manual)) {
      console.warn(
        `[channelTradingConfig] healed incomplete per-channel config for ${key}`
        + ' — open Account Configuration, set lot + Single/Multi, Save',
      )
    } else if (!existing?.manual_settings || !channelManualSettingsComplete(existing.manual_settings)) {
      console.warn(
        `[channelTradingConfig] healed missing per-channel config for ${key}`
        + (multiChannel
          ? ' from defaults — re-save Account Configuration for this channel'
          : ' from broker manual_settings / defaults — re-save Account Configuration for this channel'),
      )
    }

    configs[key] = {
      copier_mode: existing?.copier_mode ?? fallbackMode,
      manual_settings: manual,
      ai_settings: (existing?.ai_settings ?? broker.ai_settings ?? {}) as Record<string, unknown>,
      copy_limit_state: existing?.copy_limit_state,
    }
  }
  return configs
}

export function buildDefaultChannelTradingConfig(): ChannelTradingConfig {
  return {
    copier_mode: 'manual',
    manual_settings: normalizeManualSettingsForExecution({
      fixed_lot: 0.01,
      trade_style: 'single',
      risk_mode: 'fixed_lot',
    }) as Record<string, unknown>,
    ai_settings: {},
  }
}

/** Per-channel manual_settings must include fixed_lot and trade_style before execution. */
export function channelManualSettingsComplete(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const normalized = normalizeManualSettingsForExecution(raw) as Record<string, unknown>
  const lot = Number(normalized.fixed_lot)
  const style = normalized.trade_style
  return Number.isFinite(lot) && lot > 0 && (style === 'single' || style === 'multi')
}

/**
 * Migration/connect paths persist a tiny default row ({ fixed_lot: 0.01, trade_style: single, … })
 * that looks "complete" but was never configured in the UI. Treat as incomplete so broker
 * manual_settings can heal it.
 */
export function isMinimalSeedManualSettings(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return true
  const row = raw as Record<string, unknown>
  if ('schema_version' in row) return false
  if (row.copy_limits != null && typeof row.copy_limits === 'object') return false
  if (!channelManualSettingsComplete(row)) return true
  const keys = Object.keys(row).filter(k => row[k] !== undefined && row[k] !== null)
  if (keys.length > 4) return false
  const lot = Number(row.fixed_lot)
  const style = row.trade_style
  const risk = row.risk_mode
  return lot === 0.01 && style === 'single' && (risk === 'fixed_lot' || risk == null)
}

export function storedPerChannelConfigComplete(
  configs: ChannelTradingConfigsMap,
  channelId: string,
): boolean {
  const entry = resolveChannelConfigEntry(configs, channelId)
  if (!entry) return false
  if (isMinimalSeedManualSettings(entry.manual_settings)) return false
  return channelManualSettingsComplete(entry.manual_settings)
}

export function channelConfigReadyForExecution(
  broker: BrokerChannelTradingFields,
  channelId: string | null | undefined,
): ChannelConfigReadyResult {
  const normalizedChannelId = normalizeChannelUuid(channelId)
  if (!normalizedChannelId) {
    return { ready: true, source: 'unlinked' }
  }
  const linked = normalizeSignalChannelIds(broker.signal_channel_ids)
  const linkedNormalized = linked.map(id => normalizeChannelUuid(id)).filter(Boolean) as string[]
  if (!linkedNormalized.includes(normalizedChannelId)) {
    return { ready: true, source: 'unlinked' }
  }
  const healed = healChannelTradingConfigsMap(broker)
  const entry = resolveChannelConfigEntry(healed, normalizedChannelId)
  if (!entry) {
    return { ready: false, reason: 'channel_config_missing', channelId: normalizedChannelId }
  }
  if (!channelManualSettingsComplete(entry.manual_settings)) {
    return { ready: false, reason: 'channel_config_incomplete', channelId: normalizedChannelId }
  }
  return { ready: true, source: 'per_channel' }
}

export function resolveChannelTradingConfig(
  broker: BrokerChannelTradingFields,
  channelId: string | null | undefined,
): {
  copier_mode: 'ai' | 'manual'
  manual_settings: Record<string, unknown>
  ai_settings: Record<string, unknown>
  config_source: ChannelConfigSource
} {
  const fallbackMode = (broker.copier_mode ?? 'manual') as 'ai' | 'manual'
  const balance = brokerAccountBalance(broker)
  const fallbackManual = normalizeManualSettingsForExecution(broker.manual_settings, { accountBalance: balance }) as Record<string, unknown>
  const fallbackAi = (broker.ai_settings ?? {}) as Record<string, unknown>

  if (!channelId) {
    return {
      copier_mode: fallbackMode,
      manual_settings: fallbackManual,
      ai_settings: fallbackAi,
      config_source: 'unlinked',
    }
  }

  const configs = healChannelTradingConfigsMap(broker)
  const channelConfig = resolveChannelConfigEntry(configs, channelId)
  const ready = channelConfigReadyForExecution(broker, channelId)

  if (ready.ready && ready.source === 'per_channel' && channelConfig) {
    return {
      copier_mode: channelConfig.copier_mode ?? fallbackMode,
      manual_settings: normalizeManualSettingsForExecution(
        channelConfig.manual_settings,
        { accountBalance: balance },
      ) as Record<string, unknown>,
      ai_settings: (channelConfig.ai_settings ?? fallbackAi) as Record<string, unknown>,
      config_source: 'per_channel',
    }
  }

  if (ready.ready && ready.source === 'unlinked') {
    return {
      copier_mode: fallbackMode,
      manual_settings: fallbackManual,
      ai_settings: fallbackAi,
      config_source: 'broker_fallback',
    }
  }

  // Linked channel without complete per-channel config — caller must skip execution.
  return {
    copier_mode: fallbackMode,
    manual_settings: fallbackManual,
    ai_settings: fallbackAi,
    config_source: 'broker_fallback',
  }
}

export function withChannelTradingConfig<T extends BrokerChannelTradingFields>(
  broker: T,
  channelId: string | null | undefined,
): T {
  const resolved = resolveChannelTradingConfig(broker, channelId)
  return {
    ...broker,
    copier_mode: resolved.copier_mode,
    manual_settings: resolved.manual_settings,
    ai_settings: resolved.ai_settings,
  }
}

/**
 * True when persisting the healed config would actually change the stored row.
 * Content is compared with the shared `stableStringify` so key order is
 * irrelevant. `copy_limit_state` is deliberately excluded: the heal passes it
 * through, and the copy-limit monitor owns it. Writing identical content back
 * is a no-op that can feed a write→realtime-event→write loop (incident
 * 2026-10-28).
 */
export function healedConfigPersistDiffers(
  stored: ChannelTradingConfig | undefined,
  cfg: ChannelTradingConfig,
): boolean {
  if (!stored) return true
  return stableStringify(stored.copier_mode ?? null) !== stableStringify(cfg.copier_mode ?? null)
    || stableStringify(stored.manual_settings ?? null) !== stableStringify(cfg.manual_settings ?? null)
    || stableStringify(stored.ai_settings ?? null) !== stableStringify(cfg.ai_settings ?? null)
}

/** Minimum spacing between heal-persists for one broker|channel (incident 2026-10-28). */
const HEAL_PERSIST_COOLDOWN_MS = 10 * 60 * 1000
const healPersistLastAttemptAtByKey = new Map<string, number>()

/**
 * Rate guard for heal-persists. Returns true when a persist for `key` was
 * already attempted inside the cooldown window (caller must skip); otherwise
 * records this attempt and returns false.
 */
export function healPersistWithinCooldown(
  key: string,
  now: number = Date.now(),
  cooldownMs: number = HEAL_PERSIST_COOLDOWN_MS,
): boolean {
  const last = healPersistLastAttemptAtByKey.get(key)
  if (last != null && now - last < cooldownMs) return true
  healPersistLastAttemptAtByKey.set(key, now)
  if (healPersistLastAttemptAtByKey.size > 5000) {
    for (const [k, t] of healPersistLastAttemptAtByKey) {
      if (now - t >= cooldownMs) healPersistLastAttemptAtByKey.delete(k)
    }
  }
  return false
}

export function resetHealPersistCooldownsForTests(): void {
  healPersistLastAttemptAtByKey.clear()
}

/**
 * Persist healed per-channel configs to the `broker_channel_trading_configs` table.
 * Only writes channels whose original config was missing or incomplete, only when
 * the healed content differs from what is stored, and at most once per channel
 * per cooldown window — so no configuration state can ever loop (incident
 * 2026-10-28: a realtime-event handler called this routine, and rows that could
 * never pass the completeness check were rewritten hundreds of times per second).
 */
export async function persistHealedChannelConfigs(
  supabase: SupabaseClient,
  userId: string,
  brokerId: string,
  originalRaw: unknown,
  healedConfigs: Record<string, unknown>,
): Promise<void> {
  if (!userId) {
    console.warn(
      `[channelTradingConfig] skip persist healed configs broker=${brokerId}: missing user_id`,
    )
    return
  }
  const originalMap = normalizeChannelTradingConfigsMap(originalRaw)
  for (const [channelId, raw] of Object.entries(healedConfigs)) {
    const key = normalizeChannelUuid(channelId)
    if (!key) continue
    const orig = originalMap[key]
    if (orig && storedPerChannelConfigComplete({ [key]: orig }, key)) continue
    const cfg = raw as ChannelTradingConfig
    if (orig && !healedConfigPersistDiffers(orig, cfg)) continue
    // A heal that is still incomplete cannot help execution (execution rejects
    // incomplete configs anyway); writing it would only materialize a row that
    // wins the JSONB merge forever. The heal's console.warn tells the user to
    // re-save Account Configuration — that save is the real fix.
    if (!channelManualSettingsComplete(cfg.manual_settings)) continue
    if (healPersistWithinCooldown(`${userId}|${brokerId}|${key}`)) continue
    const { error } = await supabase
      .from('broker_channel_trading_configs')
      .upsert({
        user_id: userId,
        broker_account_id: brokerId,
        channel_id: key,
        copier_mode: cfg.copier_mode ?? 'manual',
        manual_settings: cfg.manual_settings as Record<string, unknown> ?? {},
        ai_settings: cfg.ai_settings as Record<string, unknown> ?? {},
        copy_limit_state: cfg.copy_limit_state ?? null,
      }, { onConflict: 'broker_account_id,channel_id', ignoreDuplicates: false })
    if (error) {
      // Release the cooldown window: the persist did not happen, so a legitimate
      // heal must not be delayed by a failed attempt.
      healPersistLastAttemptAtByKey.delete(`${userId}|${brokerId}|${key}`)
      console.warn(
        `[channelTradingConfig] failed to persist healed config for broker=${brokerId} channel=${key}: ${error.message}`,
      )
    }
  }
}

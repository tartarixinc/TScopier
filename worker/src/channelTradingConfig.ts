import { normalizeManualSettingsForExecution } from './manualPlanning/normalizeManualSettings'
import type { ManualSettings } from './manualPlanning/types'
import { normalizeSignalChannelIds } from './brokerChannelFilter'

export interface ChannelTradingConfig {
  copier_mode?: 'ai' | 'manual'
  manual_settings?: ManualSettings | Record<string, unknown> | null
  ai_settings?: Record<string, unknown> | null
}

export type ChannelTradingConfigsMap = Record<string, ChannelTradingConfig>

export type BrokerChannelTradingFields = {
  copier_mode?: 'ai' | 'manual' | string | null
  manual_settings?: Record<string, unknown> | null
  ai_settings?: Record<string, unknown> | null
  channel_trading_configs?: unknown
  signal_channel_ids?: string[] | null
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

export function healChannelTradingConfigsMap(
  broker: BrokerChannelTradingFields,
): ChannelTradingConfigsMap {
  const configs = { ...normalizeChannelTradingConfigsMap(broker.channel_trading_configs) }
  const linkedIds = normalizeSignalChannelIds(broker.signal_channel_ids)
  const fallbackManual = normalizeManualSettingsForExecution(broker.manual_settings) as Record<string, unknown>
  const defaultManual = normalizeManualSettingsForExecution(
    buildDefaultChannelTradingConfig().manual_settings,
  ) as Record<string, unknown>
  const fallbackMode = (broker.copier_mode ?? 'manual') as 'ai' | 'manual'

  for (const channelId of linkedIds) {
    const key = normalizeChannelUuid(channelId)
    if (!key) continue
    if (storedPerChannelConfigComplete(configs, key)) continue

    const existing = resolveChannelConfigEntry(configs, key)
    let manual: Record<string, unknown>
    if (channelManualSettingsComplete(existing?.manual_settings)) {
      manual = normalizeManualSettingsForExecution(existing?.manual_settings) as Record<string, unknown>
    } else if (
      channelManualSettingsComplete(fallbackManual)
      && (linkedIds.length === 1 || normalizeChannelUuid(linkedIds[0]) === key)
    ) {
      manual = fallbackManual
      console.warn(
        `[channelTradingConfig] healed missing per-channel config for ${key}`
        + ' from broker manual_settings — re-save Account Configuration for this channel',
      )
    } else {
      manual = defaultManual
      console.warn(
        `[channelTradingConfig] healed missing per-channel config for ${key}`
        + ' with defaults — open Account Configuration, set lot + Single/Multi, Save',
      )
    }

    configs[key] = {
      copier_mode: existing?.copier_mode ?? fallbackMode,
      manual_settings: manual,
      ai_settings: (existing?.ai_settings ?? broker.ai_settings ?? {}) as Record<string, unknown>,
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

export function storedPerChannelConfigComplete(
  configs: ChannelTradingConfigsMap,
  channelId: string,
): boolean {
  const entry = resolveChannelConfigEntry(configs, channelId)
  if (!entry) return false
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
  const fallbackManual = normalizeManualSettingsForExecution(broker.manual_settings) as Record<string, unknown>
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

export function cloneChannelTradingConfig(from: ChannelTradingConfig): ChannelTradingConfig {
  return {
    copier_mode: from.copier_mode ?? 'manual',
    manual_settings: from.manual_settings
      ? JSON.parse(JSON.stringify(from.manual_settings))
      : buildDefaultChannelTradingConfig().manual_settings,
    ai_settings: from.ai_settings
      ? JSON.parse(JSON.stringify(from.ai_settings))
      : {},
  }
}

export function removeChannelTradingConfigKey(
  configs: ChannelTradingConfigsMap,
  channelId: string,
): ChannelTradingConfigsMap {
  const next = { ...configs }
  delete next[channelId]
  return next
}

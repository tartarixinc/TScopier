import type { Json, ManualSettings } from '../types/database'
import { normalizeCopyLimitState, type CopyLimitState } from './copyLimitTypes'
import { DEFAULT_MANUAL_SETTINGS, ensurePersistedManualSettings } from './defaultManualSettings'
import { normalizeSignalChannelIds } from './brokerChannelLink'
export interface ChannelTradingConfig {
  copier_mode?: 'ai' | 'manual'
  manual_settings?: ManualSettings | null
  ai_settings?: Json | null
  copy_limit_state?: CopyLimitState
}

export type ChannelTradingConfigsMap = Record<string, ChannelTradingConfig>

export type BrokerChannelTradingFields = {
  copier_mode?: 'ai' | 'manual' | null
  manual_settings?: Json | null
  ai_settings?: Json | null
  channel_trading_configs?: Json | null
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
        ? (row.manual_settings as ManualSettings)
        : undefined,
      ai_settings: (row.ai_settings ?? undefined) as Json | undefined,
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
  existing: ManualSettings | null | undefined,
  brokerFallback: ManualSettings,
  defaultManual: ManualSettings,
): ManualSettings {
  const base = channelManualSettingsComplete(brokerFallback) ? brokerFallback : defaultManual
  return {
    ...base,
    ...(existing && typeof existing === 'object' && !isMinimalSeedManualSettings(existing)
      ? existing
      : {}),
  }
}

export function healChannelTradingConfigsMap(
  broker: BrokerChannelTradingFields,
): ChannelTradingConfigsMap {
  const configs = { ...normalizeChannelTradingConfigsMap(broker.channel_trading_configs) }
  const linkedIds = normalizeSignalChannelIds(broker.signal_channel_ids)
  const multiChannel = linkedIds.length > 1
  const brokerFallbackManual = (broker.manual_settings && typeof broker.manual_settings === 'object'
    ? broker.manual_settings
    : DEFAULT_MANUAL_SETTINGS) as ManualSettings
  const defaultManual = buildDefaultChannelTradingConfig().manual_settings as ManualSettings
  const fallbackMode = (broker.copier_mode ?? 'manual') as 'ai' | 'manual'
  const healBrokerFallback = multiChannel ? defaultManual : brokerFallbackManual

  for (const channelId of linkedIds) {
    const key = normalizeChannelUuid(channelId)
    if (!key) continue
    if (storedPerChannelConfigComplete(configs, key)) continue

    const existing = resolveChannelConfigEntry(configs, key)
    const manual = mergeHealedChannelManualSettings(
      existing?.manual_settings,
      healBrokerFallback,
      defaultManual,
    )
    configs[key] = {
      copier_mode: existing?.copier_mode ?? fallbackMode,
      manual_settings: manual,
      ai_settings: (existing?.ai_settings ?? broker.ai_settings ?? {}) as Json,
      copy_limit_state: existing?.copy_limit_state,
    }
  }
  return configs
}

export function buildDefaultChannelTradingConfig(): ChannelTradingConfig {
  return {
    copier_mode: 'manual',
    manual_settings: JSON.parse(JSON.stringify(DEFAULT_MANUAL_SETTINGS)) as ManualSettings,
    ai_settings: {} as Json,
  }
}

export function channelManualSettingsComplete(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const ms = raw as Record<string, unknown>
  const lot = Number(ms.fixed_lot)
  const style = ms.trade_style
  return Number.isFinite(lot) && lot > 0 && (style === 'single' || style === 'multi')
}

/** See worker `isMinimalSeedManualSettings` — tiny DB rows from migration/connect, not UI saves. */
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
  if (!linked.includes(normalizedChannelId)) {
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
  manual_settings: ManualSettings
  ai_settings: Json
  config_source: ChannelConfigSource
} {
  const fallbackMode = (broker.copier_mode ?? 'manual') as 'ai' | 'manual'
  const fallbackManual = (broker.manual_settings && typeof broker.manual_settings === 'object'
    ? broker.manual_settings
    : DEFAULT_MANUAL_SETTINGS) as ManualSettings
  const fallbackAi = (broker.ai_settings ?? {}) as Json

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

  if (ready.ready && ready.source === 'per_channel' && channelConfig?.manual_settings) {
    return {
      copier_mode: channelConfig.copier_mode ?? fallbackMode,
      manual_settings: channelConfig.manual_settings as ManualSettings,
      ai_settings: (channelConfig.ai_settings ?? fallbackAi) as Json,
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

  return {
    copier_mode: fallbackMode,
    manual_settings: fallbackManual,
    ai_settings: fallbackAi,
    config_source: 'broker_fallback',
  }
}

export function cloneChannelTradingConfig(from: ChannelTradingConfig): ChannelTradingConfig {
  return {
    copier_mode: from.copier_mode ?? 'manual',
    manual_settings: from.manual_settings
      ? (JSON.parse(JSON.stringify(from.manual_settings)) as ManualSettings)
      : (JSON.parse(JSON.stringify(DEFAULT_MANUAL_SETTINGS)) as ManualSettings),
    ai_settings: from.ai_settings
      ? JSON.parse(JSON.stringify(from.ai_settings))
      : ({} as Json),
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

export function buildChannelTradingConfigsFromDraft(
  channelIds: string[],
  draftConfigs: Record<string, { mode: 'ai' | 'manual'; manualSettings: ManualSettings }>,
): ChannelTradingConfigsMap {
  const out: ChannelTradingConfigsMap = {}
  for (const channelId of channelIds) {
    const key = normalizeChannelUuid(channelId)
    if (!key) continue
    const draft = draftConfigs[channelId] ?? draftConfigs[key]
    if (!draft) continue
    out[key] = {
      copier_mode: draft.mode,
      manual_settings: ensurePersistedManualSettings({
        ...draft.manualSettings,
        allow_high_impact_news: draft.manualSettings.news_trading_enabled === true,
      }),
      ai_settings: {} as Json,
    }
  }
  return out
}

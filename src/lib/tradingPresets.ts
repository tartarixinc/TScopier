import { supabase } from './supabase'
import type { ManualSettings } from '../types/database'
import {
  DEFAULT_CHANNEL_FILTERS,
  normalizeChannelFilters,
  type ChannelFilters,
} from './channelMessageFilters'

export interface ChannelTradingPreset {
  id: string
  user_id: string
  name: string
  copier_mode: 'ai' | 'manual'
  manual_settings: ManualSettings
  channel_filters: ChannelFilters
  created_at: string
  updated_at: string
}

export interface ChannelConfigPresetPayload {
  mode: 'ai' | 'manual'
  manualSettings: ManualSettings
  channelFilters: ChannelFilters
}

const PRESET_SELECT = 'id,user_id,name,copier_mode,manual_settings,channel_filters,created_at,updated_at'

function normalizePresetRow(row: Record<string, unknown>): ChannelTradingPreset {
  const mode = row.copier_mode
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    name: String(row.name ?? ''),
    copier_mode: mode === 'ai' ? 'ai' : 'manual',
    manual_settings: (row.manual_settings && typeof row.manual_settings === 'object'
      ? row.manual_settings
      : {}) as ManualSettings,
    channel_filters: normalizeChannelFilters(row.channel_filters ?? DEFAULT_CHANNEL_FILTERS),
    created_at: String(row.created_at ?? ''),
    updated_at: String(row.updated_at ?? ''),
  }
}

export async function listTradingPresets(userId: string): Promise<ChannelTradingPreset[]> {
  const { data, error } = await supabase
    .from('channel_trading_presets')
    .select(PRESET_SELECT)
    .eq('user_id', userId)
    .order('name')
  if (error) throw error
  return (data ?? []).map(row => normalizePresetRow(row as Record<string, unknown>))
}

export async function upsertTradingPreset(
  userId: string,
  name: string,
  payload: ChannelConfigPresetPayload,
): Promise<ChannelTradingPreset> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Preset name is required')

  const row = {
    user_id: userId,
    name: trimmed,
    copier_mode: payload.mode,
    manual_settings: {
      ...payload.manualSettings,
      allow_high_impact_news: payload.manualSettings.news_trading_enabled === true,
    },
    channel_filters: payload.channelFilters,
  }

  const { data, error } = await supabase
    .from('channel_trading_presets')
    .upsert(row, { onConflict: 'user_id,name' })
    .select(PRESET_SELECT)
    .single()

  if (error) throw error
  return normalizePresetRow(data as Record<string, unknown>)
}

export async function renameTradingPreset(
  userId: string,
  presetId: string,
  name: string,
): Promise<ChannelTradingPreset> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Preset name is required')

  const { data, error } = await supabase
    .from('channel_trading_presets')
    .update({ name: trimmed })
    .eq('id', presetId)
    .eq('user_id', userId)
    .select(PRESET_SELECT)
    .single()

  if (error) throw error
  return normalizePresetRow(data as Record<string, unknown>)
}

export async function deleteTradingPreset(userId: string, presetId: string): Promise<void> {
  const { error } = await supabase
    .from('channel_trading_presets')
    .delete()
    .eq('id', presetId)
    .eq('user_id', userId)

  if (error) throw error
}

export function presetToChannelConfigDraft(preset: ChannelTradingPreset): ChannelConfigPresetPayload {
  return {
    mode: preset.copier_mode,
    manualSettings: JSON.parse(JSON.stringify(preset.manual_settings)) as ManualSettings,
    channelFilters: JSON.parse(JSON.stringify(preset.channel_filters)) as ChannelFilters,
  }
}

/** Portable UniCopier preset backup (JSON). Extension: .tscp */
export const TSCOPIER_PRESETS_FORMAT = 'tscopier-presets' as const
export const TSCOPIER_PRESETS_VERSION = 1 as const
export const TSCOPIER_PRESETS_EXTENSION = '.tscp'

export type TradingPresetExportItem = {
  name: string
  copier_mode: 'ai' | 'manual'
  manual_settings: ManualSettings
  channel_filters: ChannelFilters
}

export type TradingPresetsFile = {
  format: typeof TSCOPIER_PRESETS_FORMAT
  version: number
  exported_at: string
  presets: TradingPresetExportItem[]
}

export function buildTradingPresetsFile(presets: ChannelTradingPreset[]): TradingPresetsFile {
  return {
    format: TSCOPIER_PRESETS_FORMAT,
    version: TSCOPIER_PRESETS_VERSION,
    exported_at: new Date().toISOString(),
    presets: presets.map(p => ({
      name: p.name,
      copier_mode: p.copier_mode === 'ai' ? 'ai' : 'manual',
      manual_settings: JSON.parse(JSON.stringify(p.manual_settings)) as ManualSettings,
      channel_filters: normalizeChannelFilters(p.channel_filters),
    })),
  }
}

export function serializeTradingPresetsFile(presets: ChannelTradingPreset[]): string {
  return `${JSON.stringify(buildTradingPresetsFile(presets), null, 2)}\n`
}

export function downloadTradingPresetsFile(
  presets: ChannelTradingPreset[],
  filename = `tscopier-presets${TSCOPIER_PRESETS_EXTENSION}`,
): void {
  const blob = new Blob([serializeTradingPresetsFile(presets)], {
    type: 'application/json;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename.endsWith(TSCOPIER_PRESETS_EXTENSION)
    ? filename
    : `${filename}${TSCOPIER_PRESETS_EXTENSION}`
  anchor.click()
  URL.revokeObjectURL(url)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function parseTradingPresetsFile(raw: string): TradingPresetExportItem[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Invalid preset file — could not parse JSON')
  }

  const root = asRecord(parsed)
  if (!root) throw new Error('Invalid preset file — expected an object')

  const format = String(root.format ?? '')
  if (format && format !== TSCOPIER_PRESETS_FORMAT) {
    throw new Error('Invalid preset file — unrecognized format')
  }

  const version = Number(root.version ?? 1)
  if (!Number.isFinite(version) || version < 1 || version > TSCOPIER_PRESETS_VERSION) {
    throw new Error('Invalid preset file — unsupported version')
  }

  const list = Array.isArray(root.presets)
    ? root.presets
    : Array.isArray(parsed)
      ? parsed
      : null
  if (!list) throw new Error('Invalid preset file — missing presets list')
  if (list.length === 0) throw new Error('Preset file contains no presets')

  const out: TradingPresetExportItem[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    const row = asRecord(entry)
    if (!row) continue
    const name = String(row.name ?? '').trim()
    if (!name || name.length > 80) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const mode = row.copier_mode === 'ai' ? 'ai' : 'manual'
    const manual = asRecord(row.manual_settings) ?? {}
    out.push({
      name,
      copier_mode: mode,
      manual_settings: manual as ManualSettings,
      channel_filters: normalizeChannelFilters(row.channel_filters ?? DEFAULT_CHANNEL_FILTERS),
    })
  }

  if (out.length === 0) throw new Error('Preset file contains no valid presets')
  return out
}

export async function importTradingPresetsFromFile(
  userId: string,
  raw: string,
): Promise<{ imported: number; presets: ChannelTradingPreset[] }> {
  const items = parseTradingPresetsFile(raw)
  const saved: ChannelTradingPreset[] = []
  for (const item of items) {
    const row = await upsertTradingPreset(userId, item.name, {
      mode: item.copier_mode,
      manualSettings: item.manual_settings,
      channelFilters: item.channel_filters,
    })
    saved.push(row)
  }
  return { imported: saved.length, presets: saved }
}

/**
 * Auto-management (move SL to breakeven) helpers for edge functions.
 * Keep in sync with worker/src/autoManagement.ts.
 */

export type AutoBeMode = "pips" | "rr" | "money" | "tp_hit"
export type AutoBeType = "sl_only" | "sl_and_close_half"

export type AutoBeConfig = {
  mode: AutoBeMode
  triggerValue: number
  tpIndex: number
  beType: AutoBeType
  offsetPips: number
}

function positiveNum(v: number, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export function isAutoManagementEnabled(manual: {
  move_sl_to_entry_after_mode?: string
}): boolean {
  const mode = String(manual.move_sl_to_entry_after_mode ?? "none").toLowerCase()
  return mode !== "none" && mode !== ""
}

export function normalizeAutoBeConfig(manual: {
  move_sl_to_entry_after_mode?: string
  move_sl_to_entry_after_value?: number
  move_sl_to_entry_tp_index?: number
  move_sl_to_entry_type?: string
  breakeven_offset_pips?: number
}): AutoBeConfig | null {
  const rawMode = String(manual.move_sl_to_entry_after_mode ?? "none").toLowerCase()
  if (rawMode === "none" || rawMode === "") return null
  const mode: AutoBeMode =
    rawMode === "pips" || rawMode === "rr" || rawMode === "money" || rawMode === "tp_hit"
      ? rawMode
      : "pips"
  const beRaw = String(manual.move_sl_to_entry_type ?? "sl_only").toLowerCase()
  const beType: AutoBeType = beRaw === "sl_and_close_half" ? "sl_and_close_half" : "sl_only"
  return {
    mode,
    triggerValue: positiveNum(manual.move_sl_to_entry_after_value ?? 0, mode === "rr" ? 1 : 10),
    tpIndex: Math.max(1, Math.floor(Number(manual.move_sl_to_entry_tp_index ?? 1) || 1)),
    beType,
    offsetPips: positiveNum(manual.breakeven_offset_pips ?? 0, 10),
  }
}

export function autoManagementTradeSnapshot(
  manual: {
    move_sl_to_entry_after_mode?: string
    move_sl_to_entry_after_value?: number
    move_sl_to_entry_tp_index?: number
    move_sl_to_entry_type?: string
    breakeven_offset_pips?: number
  },
  entryPrice: number | null | undefined,
  sl: number | null | undefined,
): Record<string, string | number | null> {
  if (!isAutoManagementEnabled(manual)) return {}
  const entry = Number(entryPrice)
  if (!Number.isFinite(entry) || entry <= 0) return {}
  const cfg = normalizeAutoBeConfig(manual)
  if (!cfg) return {}
  const riskSl = sl != null && Number.isFinite(Number(sl)) && Number(sl) > 0 ? Number(sl) : null
  return {
    auto_be_mode: cfg.mode,
    auto_be_trigger_value: cfg.triggerValue,
    auto_be_tp_index: cfg.tpIndex,
    auto_be_type: cfg.beType,
    auto_be_offset_pips: cfg.offsetPips,
    auto_be_risk_sl: riskSl,
    auto_be_applied_at: null,
  }
}

export function manualSettingsForChannel(
  broker: {
    manual_settings?: unknown
    channel_trading_configs?: unknown
  },
  channelId: string | null | undefined,
): Record<string, unknown> {
  const fallback = broker.manual_settings && typeof broker.manual_settings === "object"
    && !Array.isArray(broker.manual_settings)
    ? (broker.manual_settings as Record<string, unknown>)
    : {}
  const channelKey = String(channelId ?? "").trim().toLowerCase()
  if (!channelKey) return fallback

  const raw = broker.channel_trading_configs
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fallback

  const configs = raw as Record<string, unknown>
  const direct = configs[channelKey]
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    const ms = (direct as Record<string, unknown>).manual_settings
    if (ms && typeof ms === "object" && !Array.isArray(ms)) {
      return ms as Record<string, unknown>
    }
  }
  for (const [key, value] of Object.entries(configs)) {
    if (key.toLowerCase() !== channelKey) continue
    if (!value || typeof value !== "object" || Array.isArray(value)) continue
    const ms = (value as Record<string, unknown>).manual_settings
    if (ms && typeof ms === "object" && !Array.isArray(ms)) {
      return ms as Record<string, unknown>
    }
  }
  return fallback
}

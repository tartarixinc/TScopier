/**
 * Ensure a `signals` row exists for a dispatched signal UUID before any
 * FK-dependent writes (`trades`, `trade_execution_logs`, `range_pending_legs`).
 *
 * Dispatch-first used to fire OrderSend before persist completed; post-fill
 * inserts then failed on `signal_id` FK and left ghost MT positions with no
 * Activities / Copier Logs.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type EnsureSignalRowArgs = {
  id: string
  user_id: string
  channel_id?: string | null
  source_kind?: 'telegram' | 'tradingview' | 'discord' | 'whatsapp' | null
  raw_message?: string | null
  status?: string
  parsed_data?: Record<string, unknown> | null
  skip_reason?: string | null
  telegram_message_id?: string | null
  reply_to_message_id?: string | null
  parent_signal_id?: string | null
  is_modification?: boolean
  pipeline_ts?: Record<string, unknown> | null
}

export type EnsureSignalRowResult = {
  ok: boolean
  /** True when a new row was written (or upsert applied). */
  written: boolean
  error?: string
  /**
   * True when a DIFFERENT signal row already owns (user_id, channel_id,
   * telegram_message_id). Callers must treat this as a duplicate message and
   * NOT dispatch / execute — the owner signal is already being handled.
   */
  duplicate?: boolean
  /** The signal id that owns the telegram message (when duplicate). */
  existingSignalId?: string
}

function resolveSourceKind(args: EnsureSignalRowArgs): string | null {
  if (args.source_kind) return args.source_kind
  const fromParsed = args.parsed_data?.signal_source
  if (typeof fromParsed === 'string') {
    const kind = fromParsed.trim().toLowerCase()
    if (kind === 'telegram' || kind === 'tradingview' || kind === 'discord' || kind === 'whatsapp') {
      return kind
    }
  }
  return args.channel_id ? 'telegram' : null
}

function buildSignalRowPatch(args: EnsureSignalRowArgs): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    id: args.id,
    user_id: args.user_id,
    channel_id: args.channel_id ?? null,
    raw_image_url: null,
    status: args.status ?? 'parsed',
    parsed_data: args.parsed_data ?? null,
    skip_reason: args.skip_reason ?? null,
    telegram_message_id: args.telegram_message_id ?? null,
    is_modification: args.is_modification === true,
    parent_signal_id: args.parent_signal_id ?? null,
    reply_to_message_id: args.reply_to_message_id ?? null,
  }
  // Only write raw_message when a non-empty value is provided. Dispatch-only
  // payloads (listener push carries no raw_message) upsert by id and must not
  // clobber the raw_message the listener already persisted for the signal —
  // otherwise the frontend Copier Logs show an empty Telegram message.
  if (typeof args.raw_message === 'string' && args.raw_message.trim().length > 0) {
    patch.raw_message = args.raw_message
  }
  if (args.pipeline_ts) {
    patch.pipeline_ts = args.pipeline_ts
  }
  const sourceKind = resolveSourceKind(args)
  if (sourceKind) patch.source_kind = sourceKind
  return patch
}

/**
 * Upsert by primary key so the dispatched UUID is always present for FKs.
 * Falls back to a telegram_message_id-null stub if the unique
 * (user, channel, telegram_message) constraint blocks the full row.
 */
export async function ensureSignalRow(
  supabase: SupabaseClient,
  args: EnsureSignalRowArgs,
): Promise<EnsureSignalRowResult> {
  if (!args.id || !args.user_id) {
    return { ok: false, written: false, error: 'missing_id_or_user' }
  }

  const row = buildSignalRowPatch(args)
  const { error } = await supabase.from('signals').upsert(row, { onConflict: 'id' })
  if (!error) return { ok: true, written: true }

  const msg = error.message ?? String(error)
  // Unique (user_id, channel_id, telegram_message_id) may already be owned by
  // another signal id. Detect the duplicate BEFORE falling back to the stub:
  // the owner signal is already being handled, so the stub must be NON-executable
  // (status 'skipped') and callers must skip dispatch.
  if (args.telegram_message_id) {
    const existing = await findSignalByTelegramMessage(
      supabase,
      args.user_id,
      args.channel_id ?? null,
      args.telegram_message_id,
    )
    if (existing) {
      const stub = {
        ...row,
        // Never executable: 'skipped' is not in PARSED_STATUSES, so neither the
        // sweep nor acceptDispatchSignal will pick it up. The row still exists so
        // FK-dependent writes (trades / trade_execution_logs) can reference it.
        status: 'skipped',
        skip_reason: 'duplicate_telegram_message',
        telegram_message_id: null,
        reply_to_message_id: null,
      }
      const { error: stubErr } = await supabase.from('signals').upsert(stub, { onConflict: 'id' })
      if (!stubErr) {
        console.warn(
          `[ensureSignalRow] duplicate telegram message signal=${args.id} owned by signal=${existing}`
          + ` — persisted non-executable skipped stub (${msg.slice(0, 200)})`,
        )
        return { ok: true, written: true, duplicate: true, existingSignalId: existing }
      }
      console.error(
        `[ensureSignalRow] duplicate stub upsert failed signal=${args.id}: ${stubErr.message} (primary: ${msg.slice(0, 200)})`,
      )
      return { ok: false, written: false, duplicate: true, existingSignalId: existing, error: stubErr.message }
    }
  }
  // Still ensure THIS id exists so OrderSend post-fill FKs work.
  if (args.telegram_message_id) {
    const stub = {
      ...row,
      telegram_message_id: null,
      reply_to_message_id: null,
    }
    const { error: stubErr } = await supabase.from('signals').upsert(stub, { onConflict: 'id' })
    if (!stubErr) {
      console.warn(
        `[ensureSignalRow] upserted stub without telegram_message_id signal=${args.id}`
        + ` after conflict: ${msg.slice(0, 200)}`,
      )
      return { ok: true, written: true }
    }
    console.error(
      `[ensureSignalRow] stub upsert failed signal=${args.id}: ${stubErr.message} (primary: ${msg.slice(0, 200)})`,
    )
    return { ok: false, written: false, error: stubErr.message }
  }

  console.error(`[ensureSignalRow] upsert failed signal=${args.id}: ${msg}`)
  return { ok: false, written: false, error: msg }
}

/** True when a PostgREST / Postgres error looks like a missing-signal FK violation. */
export function isSignalFkViolation(message: string | null | undefined): boolean {
  const m = String(message ?? '').toLowerCase()
  if (!m) return false
  return (
    m.includes('signals')
    && (m.includes('foreign key') || m.includes('violates foreign key') || m.includes('signal_id'))
  ) || m.includes('trades_signal_id_fkey')
    || m.includes('trade_execution_logs_signal_id_fkey')
    || m.includes('range_pending_legs_signal_id_fkey')
    || m.includes('partial_tp_legs_signal_id_fkey')
}

async function findSignalByTelegramMessage(
  supabase: SupabaseClient,
  userId: string,
  channelId: string | null,
  telegramMessageId: string,
): Promise<string | null> {
  try {
    let query = supabase
      .from('signals')
      .select('id')
      .eq('user_id', userId)
      .eq('telegram_message_id', telegramMessageId)
    if (channelId) query = query.eq('channel_id', channelId)
    const { data } = await query.limit(1)
    return (data?.[0]?.id as string | undefined) ?? null
  } catch {
    return null
  }
}

import type { SupabaseClient } from '@supabase/supabase-js'

/** Stable token returned to clients; UI maps to localized copy. */
export const TELEGRAM_ALREADY_LINKED = 'TELEGRAM_ALREADY_LINKED'

/**
 * True only for the claim refusal itself. Database read failures and anything
 * else thrown while checking availability must never be mistaken for "this
 * Telegram is already linked", because that is the one error an admin override
 * is allowed to look past.
 */
export function isTelegramAlreadyLinkedError(err: unknown): boolean {
  return err instanceof Error && err.message === TELEGRAM_ALREADY_LINKED
}

export function normalizeTelegramPhoneNumber(raw: string): string {
  const compact = String(raw ?? '')
    .trim()
    .replace(/[\s\-()]/g, '')
  if (compact.startsWith('00')) return `+${compact.slice(2)}`
  return compact
}

export async function assertTelegramAccountAvailable(
  supabase: SupabaseClient,
  userId: string,
  opts: { phone?: string; telegramUserId?: string | number | bigint | null },
): Promise<void> {
  const phone = opts.phone ? normalizeTelegramPhoneNumber(opts.phone) : ''
  const telegramUserId =
    opts.telegramUserId == null || opts.telegramUserId === ''
      ? null
      : String(opts.telegramUserId)

  if (phone) {
    const { data, error } = await supabase
      .from('telegram_account_claims')
      .select('user_id')
      .eq('phone_number_normalized', phone)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (data?.user_id && data.user_id !== userId) {
      throw new Error(TELEGRAM_ALREADY_LINKED)
    }
  }

  if (telegramUserId) {
    const { data, error } = await supabase
      .from('telegram_account_claims')
      .select('user_id')
      .eq('telegram_user_id', telegramUserId)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (data?.user_id && data.user_id !== userId) {
      throw new Error(TELEGRAM_ALREADY_LINKED)
    }
  }
}

/** A claim row as stored, so a released claim can be put back unchanged. */
export type TelegramAccountClaimRow = {
  user_id: string
  telegram_user_id: string | number | null
  phone_number_normalized: string
  linked_at?: string | null
}

/**
 * Claim rows held by SOMEONE ELSE that bind this phone number or Telegram user
 * id. Returned in full (not just the owner) so a release can be undone if the
 * link that triggered it fails afterwards.
 *
 * Throws the same database error the availability check throws, so a failure to
 * read claims is never mistaken for "the account is free".
 */
export async function listConflictingTelegramClaims(
  supabase: SupabaseClient,
  userId: string,
  opts: { phone?: string; telegramUserId?: string | number | bigint | null },
): Promise<TelegramAccountClaimRow[]> {
  const phone = opts.phone ? normalizeTelegramPhoneNumber(opts.phone) : ''
  const telegramUserId =
    opts.telegramUserId == null || opts.telegramUserId === ''
      ? null
      : String(opts.telegramUserId)

  const conflicts = new Map<string, TelegramAccountClaimRow>()

  if (phone) {
    const { data, error } = await supabase
      .from('telegram_account_claims')
      .select('user_id, telegram_user_id, phone_number_normalized, linked_at')
      .eq('phone_number_normalized', phone)
    if (error) throw new Error(error.message)
    for (const row of (data ?? []) as TelegramAccountClaimRow[]) {
      if (row?.user_id && row.user_id !== userId) conflicts.set(row.user_id, row)
    }
  }

  if (telegramUserId) {
    const { data, error } = await supabase
      .from('telegram_account_claims')
      .select('user_id, telegram_user_id, phone_number_normalized, linked_at')
      .eq('telegram_user_id', telegramUserId)
    if (error) throw new Error(error.message)
    for (const row of (data ?? []) as TelegramAccountClaimRow[]) {
      if (row?.user_id && row.user_id !== userId) conflicts.set(row.user_id, row)
    }
  }

  return [...conflicts.values()]
}

/**
 * Admin-only takeover: drop the claim rows another user holds on this phone
 * number or Telegram user id so the caller's link can take the binding over.
 * Returns the rows that were released — empty when nothing was in the way.
 *
 * Callers must only reach this when an admin override is active. Nothing else
 * about the other user's account is touched: their session keeps running.
 */
export async function releaseConflictingTelegramClaims(
  supabase: SupabaseClient,
  userId: string,
  opts: { phone?: string; telegramUserId?: string | number | bigint | null },
): Promise<TelegramAccountClaimRow[]> {
  const conflicts = await listConflictingTelegramClaims(supabase, userId, opts)
  if (!conflicts.length) return []
  const { error } = await supabase
    .from('telegram_account_claims')
    .delete()
    .in('user_id', conflicts.map(row => row.user_id))
  if (error) throw new Error(error.message)
  return conflicts
}

/** Put released claim rows back — used when the link that released them failed. */
export async function restoreTelegramAccountClaims(
  supabase: SupabaseClient,
  rows: TelegramAccountClaimRow[],
): Promise<void> {
  if (!rows.length) return
  const { error } = await supabase.from('telegram_account_claims').insert(
    rows.map(row => ({
      user_id: row.user_id,
      telegram_user_id: row.telegram_user_id ?? null,
      phone_number_normalized: row.phone_number_normalized,
      linked_at: row.linked_at ?? new Date().toISOString(),
    })),
  )
  if (error) throw new Error(error.message)
}

export async function upsertTelegramAccountClaim(
  supabase: SupabaseClient,
  userId: string,
  opts: { phone: string; telegramUserId: string | number | bigint },
): Promise<void> {
  const phone = normalizeTelegramPhoneNumber(opts.phone)
  const telegramUserId = String(opts.telegramUserId)
  const { error } = await supabase.from('telegram_account_claims').upsert(
    {
      user_id: userId,
      telegram_user_id: telegramUserId,
      phone_number_normalized: phone,
      linked_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  )
  if (error) throw new Error(error.message)
}

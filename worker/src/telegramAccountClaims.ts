import type { SupabaseClient } from '@supabase/supabase-js'

/** Stable token returned to clients; UI maps to localized copy. */
export const TELEGRAM_ALREADY_LINKED = 'TELEGRAM_ALREADY_LINKED'

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

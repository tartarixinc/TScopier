/**
 * Frontend add-channel flow: upsert permanent signal_channels registry, link subscription.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { isNumericTelegramChatId, normalizeTelegramChatId } from './telegramChannelIdentity'

export interface ChannelSubscriptionInput {
  userId: string
  telegramChatId: string
  channelUsername?: string
  displayName?: string
}

function canonicalChatId(raw: string): string {
  return isNumericTelegramChatId(raw) ? normalizeTelegramChatId(raw) : raw.trim()
}

/** Upsert immortal registry row; returns signal_channels.id. */
export async function resolveOrCreateSignalChannelClient(
  supabase: SupabaseClient,
  input: Omit<ChannelSubscriptionInput, 'userId'>,
): Promise<{ signalChannelId: string | null; error: string | null }> {
  const telegramChatId = canonicalChatId(input.telegramChatId)
  if (!telegramChatId) {
    return { signalChannelId: null, error: 'invalid_channel_id' }
  }

  const { data, error } = await supabase
    .from('signal_channels')
    .upsert(
      {
        telegram_chat_id: telegramChatId,
        channel_username: (input.channelUsername ?? '').replace(/^@/, '').toLowerCase(),
        display_name: (input.displayName ?? '').trim() || telegramChatId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'telegram_chat_id' },
    )
    .select('id')
    .single()

  if (error) return { signalChannelId: null, error: error.message }
  return { signalChannelId: (data as { id: string }).id, error: null }
}

/** After telegram_channels upsert, link subscription to registry. */
export async function linkSubscriptionAfterChannelUpsert(
  supabase: SupabaseClient,
  input: ChannelSubscriptionInput & { subscriptionRowId: string },
): Promise<{ signalChannelId: string | null; error: string | null }> {
  const { signalChannelId, error } = await resolveOrCreateSignalChannelClient(supabase, input)
  if (error || !signalChannelId) return { signalChannelId: null, error }

  const { error: linkErr } = await supabase
    .from('telegram_channels')
    .update({ signal_channel_id: signalChannelId })
    .eq('id', input.subscriptionRowId)
    .eq('user_id', input.userId)

  if (linkErr) return { signalChannelId: null, error: linkErr.message }
  return { signalChannelId, error: null }
}

/** Build telegram_channels upsert payload with signal_channel_id when chat id is numeric. */
export async function prepareChannelSubscriptionUpsert(
  supabase: SupabaseClient,
  input: ChannelSubscriptionInput & {
    isActive?: boolean
    lotSizeOverride?: number | null
    pipToleranceOverride?: number | null
  },
): Promise<{
  row: Record<string, unknown>
  signalChannelId: string | null
  error: string | null
}> {
  let signalChannelId: string | null = null
  if (isNumericTelegramChatId(input.telegramChatId)) {
    const resolved = await resolveOrCreateSignalChannelClient(supabase, input)
    if (resolved.error) return { row: {}, signalChannelId: null, error: resolved.error }
    signalChannelId = resolved.signalChannelId
  }

  const row: Record<string, unknown> = {
    user_id: input.userId,
    channel_id: input.telegramChatId,
    channel_username: (input.channelUsername ?? '').replace(/^@/, ''),
    display_name: (input.displayName ?? '').trim(),
    is_active: input.isActive ?? true,
  }
  if (signalChannelId) row.signal_channel_id = signalChannelId
  if (input.lotSizeOverride !== undefined) row.lot_size_override = input.lotSizeOverride
  if (input.pipToleranceOverride !== undefined) row.pip_tolerance_override = input.pipToleranceOverride

  return { row, signalChannelId, error: null }
}

import type { SupabaseClient } from '@supabase/supabase-js'

export interface SocialCopyAttribution {
  /** Provider display name when known; otherwise a short fallback. */
  providerName: string
  sourceTicket: string
  subscriptionId: string | null
  mappingId: string | null
  mappingState: string | null
}

type SubscriptionRow = {
  id: string
  source_trader_user_id: string
}

type MappingRow = {
  id: string
  subscription_id: string
  source_ticket: string
  state: string
  destination_ticket: string | null
  broker_comment: string
}

/**
 * Parse the social-copy broker comment `sc:<subscription8>:<sourceTicket>`
 * (see worker / edge reconciler). Returns null for anything else.
 */
export function parseSocialCopyComment(
  comment: string | null | undefined,
): { subscriptionPrefix: string; sourceTicket: string } | null {
  const match = /^sc:([0-9a-f]{8}):(\S+)/i.exec(String(comment ?? '').trim())
  if (!match) return null
  return { subscriptionPrefix: match[1]!.toLowerCase(), sourceTicket: match[2]! }
}

async function loadProviderName(
  supabase: SupabaseClient,
  traderUserId: string,
): Promise<string> {
  try {
    const { data, error } = await supabase.rpc('get_social_directory')
    if (error || !Array.isArray(data)) return 'Provider'
    const row = (data as Array<{ profile_user_id?: string; display_name?: string; username?: string }>)
      .find(item => String(item.profile_user_id ?? '') === traderUserId)
    const name = String(row?.display_name ?? '').trim() || String(row?.username ?? '').trim()
    return name || 'Provider'
  } catch {
    return 'Provider'
  }
}

function attributionFrom(
  subscription: SubscriptionRow,
  mapping: MappingRow | null,
  providerName: string,
  sourceTicket: string,
): SocialCopyAttribution {
  return {
    providerName,
    sourceTicket,
    subscriptionId: subscription.id,
    mappingId: mapping?.id ?? null,
    mappingState: mapping?.state ?? null,
  }
}

/**
 * Resolve the social-trading provider behind a copied trade. Best-effort: never
 * throws into the trade modal. Prefers the `sc:` broker comment; falls back to
 * matching the destination ticket on the user's social mappings.
 */
export async function fetchSocialCopyAttribution(
  supabase: SupabaseClient,
  userId: string,
  comment: string | null | undefined,
  destinationTicket?: string | number | null,
): Promise<SocialCopyAttribution | null> {
  if (!userId) return null

  const { data: subs, error: subError } = await supabase
    .from('social_copy_subscriptions')
    .select('id,source_trader_user_id')
    .eq('subscriber_user_id', userId)
  if (subError || !subs?.length) return null
  const subscriptions = subs as SubscriptionRow[]

  const parsed = parseSocialCopyComment(comment)
  if (parsed) {
    const subscription = subscriptions.find(
      row => row.id.slice(0, 8).toLowerCase() === parsed.subscriptionPrefix,
    )
    if (subscription) {
      const { data: mappingData } = await supabase
        .from('social_copy_trade_mappings')
        .select('id,subscription_id,source_ticket,state,destination_ticket,broker_comment')
        .eq('subscription_id', subscription.id)
        .eq('source_ticket', parsed.sourceTicket)
        .maybeSingle()
      const mapping = (mappingData as MappingRow | null) ?? null
      const providerName = await loadProviderName(supabase, subscription.source_trader_user_id)
      return attributionFrom(subscription, mapping, providerName, parsed.sourceTicket)
    }
  }

  const ticket = String(destinationTicket ?? '').trim()
  if (!ticket) return null

  const subscriptionIds = subscriptions.map(row => row.id)
  const { data: mappingRows, error: mappingError } = await supabase
    .from('social_copy_trade_mappings')
    .select('id,subscription_id,source_ticket,state,destination_ticket,broker_comment')
    .in('subscription_id', subscriptionIds)
    .eq('destination_ticket', ticket)
    .limit(1)
  if (mappingError || !mappingRows?.length) return null

  const mapping = mappingRows[0] as MappingRow
  const subscription = subscriptions.find(row => row.id === mapping.subscription_id)
  if (!subscription) return null
  const providerName = await loadProviderName(supabase, subscription.source_trader_user_id)
  return attributionFrom(subscription, mapping, providerName, mapping.source_ticket)
}

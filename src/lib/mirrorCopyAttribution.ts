import type { SupabaseClient } from '@supabase/supabase-js'

export interface MirrorCopyAttribution {
  masterLogin: string
  sourceTicket: string
}

/**
 * Parse the mirror engine's deterministic broker comment `mc:<link8>:<sourceTicket>`
 * (see worker mirrorCopyComment). Returns null for anything else — signal comments,
 * manual trades, or older formats.
 */
export function parseMirrorCopyComment(
  comment: string | null | undefined,
): { linkPrefix: string; sourceTicket: string } | null {
  const match = /^mc:([0-9a-f]{8}):(\S+)/i.exec(String(comment ?? '').trim())
  if (!match) return null
  return { linkPrefix: match[1]!.toLowerCase(), sourceTicket: match[2]! }
}

/**
 * Resolve the master account behind a slave trade's `mc:` comment. Returns null
 * when the comment is absent, or when the link (or master account) can no longer
 * be found — the note is best-effort and must never block the modal.
 */
export async function fetchMirrorCopyAttribution(
  supabase: SupabaseClient,
  userId: string,
  comment: string | null | undefined,
): Promise<MirrorCopyAttribution | null> {
  const parsed = parseMirrorCopyComment(comment)
  if (!parsed || !userId) return null

  const { data: links, error } = await supabase
    .from('broker_copy_links')
    .select('id, source_broker_account_id')
    .eq('user_id', userId)
  if (error || !links) return null

  const link = (links as Array<{ id: string; source_broker_account_id: string }>).find(
    row => row.id.slice(0, 8).toLowerCase() === parsed.linkPrefix,
  )
  if (!link) return null

  const { data: master, error: masterError } = await supabase
    .from('broker_accounts')
    .select('account_login')
    .eq('id', link.source_broker_account_id)
    .eq('user_id', userId)
    .maybeSingle()
  if (masterError || !master) return null

  const masterLogin = String((master as { account_login?: unknown }).account_login ?? '').trim()
  if (!masterLogin) return null
  return { masterLogin, sourceTicket: parsed.sourceTicket }
}

import type { SupabaseClient } from '@supabase/supabase-js'

export interface MirrorCopyAttribution {
  masterLogin: string
  sourceTicket: string
  /** Ledger row for this copy (one per link+source ticket); null when unreadable. */
  mappingId: string | null
  /** Ledger state: open / closing / closed / uncertain / error / opening. */
  mappingState: string | null
  /** Why the engine closed the copy, when the ledger recorded it. */
  mappingCloseReason: string | null
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
 * be found — the note is best-effort and must never block the modal. The ledger
 * mapping is read best-effort too: its absence (or a missing SELECT policy)
 * degrades to `mappingId: null`, which only hides the close button.
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

  const mappingQuery = (columns: string) => supabase
    .from('mirror_copy_trade_mappings')
    .select(columns)
    .eq('link_id', link.id)
    .eq('source_ticket', parsed.sourceTicket)
    .maybeSingle()

  const [master, mappingWithReason] = await Promise.all([
    supabase
      .from('broker_accounts')
      .select('account_login')
      .eq('id', link.source_broker_account_id)
      .eq('user_id', userId)
      .maybeSingle(),
    mappingQuery('id, state, close_reason'),
  ])
  if (master.error || !master.data) return null

  // The close_reason column arrives with migration 20261027120000. Until it is
  // applied, the richer SELECT fails and the note still needs id/state (the close
  // button depends on them), so retry with the original columns.
  const mapping = mappingWithReason.error ? await mappingQuery('id, state') : mappingWithReason

  const masterLogin = String((master.data as { account_login?: unknown }).account_login ?? '').trim()
  if (!masterLogin) return null

  const mappingRow = mapping.error
    ? null
    : (mapping.data as { id?: unknown; state?: unknown; close_reason?: unknown } | null)
  const storedReason = typeof mappingRow?.close_reason === 'string' ? mappingRow.close_reason.trim() : ''
  return {
    masterLogin,
    sourceTicket: parsed.sourceTicket,
    mappingId: mappingRow && typeof mappingRow.id === 'string' ? mappingRow.id : null,
    mappingState: mappingRow && typeof mappingRow.state === 'string' ? mappingRow.state : null,
    mappingCloseReason: storedReason || null,
  }
}

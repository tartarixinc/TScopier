import type { SupabaseClient } from '@supabase/supabase-js'
import type { BrokerAccount, BrokerCopyLink, ManualSettings } from '../types/database'
import { selectBrokerAccountColumns } from './brokerAccountSelect'
import { DEFAULT_MANUAL_SETTINGS, ensurePersistedManualSettings } from './defaultManualSettings'

export interface BrokerCopyLinkRow {
  id: string
  source_broker_account_id: string
  destination_broker_account_id: string
  manual_settings: ManualSettings
}

function asSettings(value: unknown): ManualSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_MANUAL_SETTINGS }
  return ensurePersistedManualSettings({ ...DEFAULT_MANUAL_SETTINGS, ...(value as ManualSettings) })
}

/** Shared read of the user's copy links; optional destination narrows to slave links. */
async function fetchCopyLinkRows(
  supabase: SupabaseClient,
  userId: string,
  destinationBrokerId?: string,
): Promise<{ links: BrokerCopyLinkRow[]; error: string | null }> {
  let query = supabase
    .from('broker_copy_links')
    .select('id,source_broker_account_id,destination_broker_account_id,manual_settings')
    .eq('user_id', userId)
  if (destinationBrokerId) query = query.eq('destination_broker_account_id', destinationBrokerId)
  const { data, error } = await query
  if (error) {
    if (/broker_copy_links/i.test(error.message) && /schema cache|does not exist|could not find/i.test(error.message)) {
      return { links: [], error: null }
    }
    return { links: [], error: error.message }
  }
  const links = ((data ?? []) as Pick<BrokerCopyLink, 'id' | 'source_broker_account_id' | 'destination_broker_account_id' | 'manual_settings'>[]).map(row => ({
    id: row.id,
    source_broker_account_id: row.source_broker_account_id,
    destination_broker_account_id: row.destination_broker_account_id,
    manual_settings: asSettings(row.manual_settings),
  }))
  return { links, error: null }
}

export async function fetchBrokerCopyLinks(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ links: BrokerCopyLinkRow[]; error: string | null }> {
  return fetchCopyLinkRows(supabase, userId)
}

/** Read the copy links where this broker is the slave (destination). */
export async function fetchBrokerCopyDestinationLinks(
  supabase: SupabaseClient,
  userId: string,
  destinationBrokerId: string,
): Promise<{ links: BrokerCopyLinkRow[]; error: string | null }> {
  return fetchCopyLinkRows(supabase, userId, destinationBrokerId)
}

export async function setBrokerCopySource(
  supabase: SupabaseClient,
  userId: string,
  brokerId: string,
  copySource: boolean,
): Promise<{ broker: BrokerAccount | null; error: string | null }> {
  if (copySource) {
    const { error: dropDestinations } = await supabase
      .from('broker_copy_links')
      .delete()
      .eq('user_id', userId)
      .eq('destination_broker_account_id', brokerId)
    if (dropDestinations) return { broker: null, error: dropDestinations.message }
  } else {
    const { error: dropSources } = await supabase
      .from('broker_copy_links')
      .delete()
      .eq('user_id', userId)
      .eq('source_broker_account_id', brokerId)
    if (dropSources) return { broker: null, error: dropSources.message }
  }

  const { data, error } = await selectBrokerAccountColumns(columns =>
    supabase
      .from('broker_accounts')
      .update({ copy_source: copySource })
      .eq('id', brokerId)
      .eq('user_id', userId)
      .select(columns)
      .single(),
  )
  if (error) return { broker: null, error: error.message }
  return { broker: data as unknown as BrokerAccount, error: null }
}

export async function connectBrokerCopyLink(
  supabase: SupabaseClient,
  userId: string,
  sourceId: string,
  destinationId: string,
): Promise<{ link: BrokerCopyLinkRow | null; error: string | null }> {
  if (sourceId === destinationId) return { link: null, error: 'A broker cannot copy to itself' }
  const settings = ensurePersistedManualSettings(DEFAULT_MANUAL_SETTINGS)
  const { data, error } = await supabase
    .from('broker_copy_links')
    .upsert({
      user_id: userId,
      source_broker_account_id: sourceId,
      destination_broker_account_id: destinationId,
      manual_settings: settings,
    }, { onConflict: 'source_broker_account_id,destination_broker_account_id', ignoreDuplicates: true })
    .select('id,source_broker_account_id,destination_broker_account_id,manual_settings')
    .maybeSingle()
  if (error) return { link: null, error: error.message }
  if (!data) {
    const existing = await supabase
      .from('broker_copy_links')
      .select('id,source_broker_account_id,destination_broker_account_id,manual_settings')
      .eq('user_id', userId)
      .eq('source_broker_account_id', sourceId)
      .eq('destination_broker_account_id', destinationId)
      .maybeSingle()
    if (existing.error || !existing.data) return { link: null, error: existing.error?.message ?? 'Could not save the broker link' }
    const row = existing.data as BrokerCopyLinkRow
    return { link: { ...row, manual_settings: asSettings(row.manual_settings) }, error: null }
  }
  const row = data as BrokerCopyLinkRow
  return { link: { ...row, manual_settings: asSettings(row.manual_settings) }, error: null }
}

export async function disconnectBrokerCopyLink(
  supabase: SupabaseClient,
  userId: string,
  sourceId: string,
  destinationId: string,
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('broker_copy_links')
    .delete()
    .eq('user_id', userId)
    .eq('source_broker_account_id', sourceId)
    .eq('destination_broker_account_id', destinationId)
  return { error: error?.message ?? null }
}

export async function updateBrokerCopyLinkSettings(
  supabase: SupabaseClient,
  userId: string,
  linkId: string,
  settings: ManualSettings,
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from('broker_copy_links')
    .update({ manual_settings: ensurePersistedManualSettings(settings) })
    .eq('id', linkId)
    .eq('user_id', userId)
  return { error: error?.message ?? null }
}

/** What the user wants the mirror engine to do with this link. */
export type MirrorCopyDesiredStatus = 'active' | 'paused' | 'stopped'

/** Worker-owned lifecycle state for a mirror link. */
export interface MirrorCopyLinkStateRow {
  link_id: string
  desired_status: MirrorCopyDesiredStatus
  status: string
  error_code: string | null
  error_detail: string | null
}

/** Read the lifecycle state for the user's links. Missing table = no rows yet. */
export async function fetchMirrorCopyLinkStates(
  supabase: SupabaseClient,
  linkIds: string[],
): Promise<{ states: Record<string, MirrorCopyLinkStateRow>; error: string | null }> {
  if (linkIds.length === 0) return { states: {}, error: null }
  const { data, error } = await supabase
    .from('mirror_copy_link_state')
    .select('link_id,desired_status,status,error_code,error_detail')
    .in('link_id', linkIds)
  if (error) {
    if (/mirror_copy_link_state/i.test(error.message) && /schema cache|does not exist|could not find/i.test(error.message)) {
      return { states: {}, error: null }
    }
    return { states: {}, error: error.message }
  }
  const states: Record<string, MirrorCopyLinkStateRow> = {}
  for (const row of (data ?? []) as MirrorCopyLinkStateRow[]) states[row.link_id] = row
  return { states, error: null }
}

/** Activate, pause, or stop copying for one link. */
export async function setMirrorCopyLinkStatus(
  supabase: SupabaseClient,
  linkId: string,
  status: MirrorCopyDesiredStatus,
): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc('set_mirror_copy_link_status', {
    p_link_id: linkId,
    p_status: status,
  })
  return { error: error?.message ?? null }
}

/** Marker the delete guard raises; stripped before the message reaches the user. */
const MIRROR_OPEN_COPIES_MARKER = 'MIRROR_OPEN_COPIES:'

/** True when the database refused a link deletion because copies are still open. */
export function isMirrorOpenCopiesError(message: string | null | undefined): boolean {
  return !!message && message.includes(MIRROR_OPEN_COPIES_MARKER)
}

/** Show the guard message without the machine-readable marker. */
export function humanizeMirrorDeleteError(message: string | null | undefined): string | null {
  if (!message) return message ?? null
  return isMirrorOpenCopiesError(message)
    ? message.slice(message.indexOf(MIRROR_OPEN_COPIES_MARKER) + MIRROR_OPEN_COPIES_MARKER.length).trim()
    : message
}

/** Shown when the worker could not confirm the flatten before the deadline. */
export const MIRROR_STOP_TIMEOUT_MESSAGE =
  'Copied trades could not be closed on the slave account, so nothing was removed. Check the broker connection and try again.'

export interface StopMirrorCopyOptions {
  /** How long to wait for the worker to confirm the flatten. */
  timeoutMs?: number
  /** Delay between state reads while waiting. */
  pollMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  onState?: (state: MirrorCopyLinkStateRow) => void
}

const realSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** Worker failures a stop can never recover from on its own; fail fast with the detail. */
const PERMANENT_STOP_FAILURES = new Set(['EXECUTION_DISABLED', 'LIVE_EXECUTION_DISABLED'])

/**
 * Ask the worker to stop a link and wait until it confirms the flatten.
 * A read error does not abort the wait; a permanent worker failure does.
 */
export async function stopMirrorCopyLinkAndWait(
  supabase: SupabaseClient,
  linkId: string,
  options: StopMirrorCopyOptions = {},
): Promise<{ stopped: boolean; error: string | null }> {
  const {
    timeoutMs = 60_000,
    pollMs = 2_000,
    now = Date.now,
    sleep = realSleep,
    onState,
  } = options
  const { error } = await setMirrorCopyLinkStatus(supabase, linkId, 'stopped')
  if (error) return { stopped: false, error }
  const deadline = now() + timeoutMs
  for (;;) {
    const { states } = await fetchMirrorCopyLinkStates(supabase, [linkId])
    const state = states[linkId]
    if (state) onState?.(state)
    if (state?.status === 'stopped') return { stopped: true, error: null }
    if (state?.status === 'error' && state.error_code && PERMANENT_STOP_FAILURES.has(state.error_code)) {
      return {
        stopped: false,
        error: state.error_detail ? `${state.error_code}: ${state.error_detail}` : state.error_code,
      }
    }
    if (now() >= deadline) return { stopped: false, error: null }
    await sleep(pollMs)
  }
}

export interface SafeDisconnectResult {
  removed: boolean
  error: string | null
}

/**
 * Delete a copy link, flattening first when the database guard refuses because
 * copied trades are still open: stop the link, wait for the worker to close the
 * copies, then retry the delete once. Nothing is deleted on a failed stop.
 */
export async function disconnectBrokerCopyLinkSafely(
  supabase: SupabaseClient,
  userId: string,
  link: Pick<BrokerCopyLinkRow, 'id' | 'source_broker_account_id' | 'destination_broker_account_id'>,
  options: StopMirrorCopyOptions = {},
): Promise<SafeDisconnectResult> {
  const attemptDelete = () => disconnectBrokerCopyLink(
    supabase,
    userId,
    link.source_broker_account_id,
    link.destination_broker_account_id,
  )
  const first = await attemptDelete()
  if (!first.error) return { removed: true, error: null }
  if (!isMirrorOpenCopiesError(first.error)) return { removed: false, error: first.error }
  const stop = await stopMirrorCopyLinkAndWait(supabase, link.id, options)
  if (stop.error) return { removed: false, error: stop.error }
  if (!stop.stopped) return { removed: false, error: MIRROR_STOP_TIMEOUT_MESSAGE }
  const retry = await attemptDelete()
  if (!retry.error) return { removed: true, error: null }
  return { removed: false, error: humanizeMirrorDeleteError(retry.error) }
}

/** Badge tone for a link's lifecycle state. */
export function mirrorCopyStatusTone(
  state: MirrorCopyLinkStateRow | undefined,
): 'success' | 'warning' | 'error' | 'neutral' {
  if (!state) return 'neutral'
  if (state.status === 'error' || state.status === 'unsupported_provider' || state.error_code) return 'error'
  if (state.status === 'stopped') return 'neutral'
  // A stop request the worker has not confirmed yet is still in flight.
  if (state.desired_status === 'stopped') return 'warning'
  if (state.status === 'active') return 'success'
  return 'warning'
}

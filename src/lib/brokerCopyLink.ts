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

export async function fetchBrokerCopyLinks(
  supabase: SupabaseClient,
  userId: string,
): Promise<{ links: BrokerCopyLinkRow[]; error: string | null }> {
  const { data, error } = await supabase
    .from('broker_copy_links')
    .select('id,source_broker_account_id,destination_broker_account_id,manual_settings')
    .eq('user_id', userId)
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

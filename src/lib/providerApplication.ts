import type { SupabaseClient } from '@supabase/supabase-js'
import type { BrokerAccount } from '../types/database'
import {
  brokerConnectionLabel,
  isSocialCopyProviderSupported,
  resolveSocialAccountMode,
  type SocialAccountMode,
} from './socialAccount'
import {
  normalizeSocialProfileLinks,
  validateSocialProfileLinks,
  type SocialProfileLinks,
} from './socialProfileLinks'

export type ProviderApplicationStatus = 'draft' | 'pending' | 'approved' | 'rejected' | 'suspended'
export type ProviderAccountKind = 'demo' | 'live' | 'prop'
export type AccountKind = ProviderAccountKind | 'unknown'

export function normalizeAccountKind(value: string | null | undefined): AccountKind {
  return value === 'demo' || value === 'live' || value === 'prop' ? value : 'unknown'
}
export type ProviderAccessMode = 'open' | 'private'

export const PROVIDER_BIO_MAX = 500
export const PROVIDER_PROP_FIRM_MAX = 80
export const PROVIDER_MAX_PRICE_USD = 100_000
/** A snapshot older than this is shown as stale in the directory. */
export const SNAPSHOT_STALE_AFTER_MS = 30 * 60_000

export type ProviderDraft = {
  brokerAccountId: string | null
  accountKind: ProviderAccountKind | null
  propFirmName: string
  /** Empty string = not decided yet; "0" = free. */
  priceUsd: string
  access: ProviderAccessMode
  bio: string
  links: SocialProfileLinks
}

export type ProviderApplication = {
  status: ProviderApplicationStatus
  draft: ProviderDraft
  termsAcceptedAt: string | null
  submittedAt: string | null
  reviewedAt: string | null
  rejectionReason: string | null
  slug: string | null
  updatedAt: string
}

type ApplicationRow = {
  status: ProviderApplicationStatus
  broker_account_id: string | null
  declared_account_kind: ProviderAccountKind | null
  prop_firm_name: string | null
  monthly_price_cents: number | string | null
  access_mode: ProviderAccessMode
  bio: string | null
  social_links: unknown
  terms_accepted_at: string | null
  submitted_at: string | null
  reviewed_at: string | null
  rejection_reason: string | null
  slug: string | null
  updated_at: string
}

export function emptyProviderDraft(): ProviderDraft {
  return { brokerAccountId: null, accountKind: null, propFirmName: '', priceUsd: '', access: 'open', bio: '', links: {} }
}

export function centsToPriceInput(cents: number | null): string {
  if (cents == null) return ''
  const dollars = cents / 100
  return Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2)
}

/** Returns whole cents, or null when the input is empty or not a valid price. */
export function priceInputToCents(input: string): number | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(trimmed)) return null
  const dollars = Number(trimmed)
  if (!Number.isFinite(dollars) || dollars < 0 || dollars > PROVIDER_MAX_PRICE_USD) return null
  return Math.round(dollars * 100)
}

function mapApplication(row: ApplicationRow): ProviderApplication {
  return {
    status: row.status,
    draft: {
      brokerAccountId: row.broker_account_id,
      accountKind: row.declared_account_kind,
      propFirmName: row.prop_firm_name ?? '',
      priceUsd: centsToPriceInput(row.monthly_price_cents == null ? null : Number(row.monthly_price_cents)),
      access: row.access_mode,
      bio: row.bio ?? '',
      links: normalizeSocialProfileLinks(row.social_links),
    },
    termsAcceptedAt: row.terms_accepted_at,
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at,
    rejectionReason: row.rejection_reason,
    slug: row.slug,
    updatedAt: row.updated_at,
  }
}

function rpcError(error: { message?: string } | null, fallback: string): Error {
  return new Error(error?.message?.trim() || fallback)
}

export async function fetchMyProviderApplication(client: SupabaseClient): Promise<ProviderApplication | null> {
  const { data, error } = await client.rpc('get_my_provider_application')
  if (error) throw rpcError(error, 'Unable to load your provider application.')
  const row = ((data ?? []) as ApplicationRow[])[0]
  return row ? mapApplication(row) : null
}

export async function saveProviderDraft(client: SupabaseClient, draft: ProviderDraft): Promise<void> {
  const { error } = await client.rpc('save_provider_draft', {
    p_broker_account_id: draft.brokerAccountId,
    p_declared_account_kind: draft.accountKind,
    p_prop_firm_name: draft.accountKind === 'prop' ? draft.propFirmName.trim() || null : null,
    p_monthly_price_cents: priceInputToCents(draft.priceUsd),
    p_access_mode: draft.access,
    p_bio: draft.bio.trim() || null,
    p_social_links: normalizeSocialProfileLinks(draft.links),
  })
  if (error) throw rpcError(error, 'Unable to save your draft.')
}

export async function submitProviderApplication(client: SupabaseClient, acceptTerms: boolean): Promise<void> {
  const { error } = await client.rpc('submit_provider_application', { p_accept_terms: acceptTerms })
  if (error) throw rpcError(error, 'Unable to submit your application.')
}

export async function updateProviderProfile(client: SupabaseClient, draft: ProviderDraft): Promise<void> {
  const cents = priceInputToCents(draft.priceUsd)
  if (cents == null) throw new Error('Enter a valid price.')
  const { error } = await client.rpc('update_provider_profile', {
    p_monthly_price_cents: cents,
    p_access_mode: draft.access,
    p_bio: draft.bio.trim() || null,
    p_social_links: normalizeSocialProfileLinks(draft.links),
  })
  if (error) throw rpcError(error, 'Unable to update your provider profile.')
}

// ---------------------------------------------------------------------------
// Account eligibility (mirrors public.provider_account_ineligibility)
// ---------------------------------------------------------------------------

export type ProviderAccountIneligibility =
  | 'inactive'
  | 'not_connected'
  | 'platform_unsupported'
  | 'mode_unverified'

export const PROVIDER_INELIGIBILITY_COPY: Record<ProviderAccountIneligibility, string> = {
  inactive: 'This account is disabled.',
  not_connected: 'Reconnect this account before you can select it.',
  platform_unsupported: 'Only MT4 and MT5 accounts can be copied right now.',
  mode_unverified: 'We could not verify whether this account is Demo or Live.',
}

export function providerAccountIneligibility(
  account: BrokerAccount,
): ProviderAccountIneligibility | null {
  if (account.is_active !== true) return 'inactive'
  if (brokerConnectionLabel(account) !== 'Connected') return 'not_connected'
  if (!isSocialCopyProviderSupported(account)) return 'platform_unsupported'
  const mode = resolveSocialAccountMode(account)
  if (mode !== 'demo' && mode !== 'live') return 'mode_unverified'
  return null
}

export function detectedAccountMode(account: BrokerAccount): SocialAccountMode {
  return resolveSocialAccountMode(account)
}

/** Formats a balance/equity in the account's own currency (never converted). */
export function formatAccountAmount(value: number | null | undefined, currency: string | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '\u2014'
  const code = (currency ?? '').trim().toUpperCase()
  if (/^[A-Z]{3}$/.test(code)) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).format(value)
    } catch { /* fall through for non-ISO codes */ }
  }
  const plain = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)
  return code ? `${plain} ${code}` : plain
}

export type SnapshotFreshness = 'fresh' | 'stale' | 'unknown'

export function snapshotFreshness(snapshotAt: string | null | undefined, now: number = Date.now()): SnapshotFreshness {
  if (!snapshotAt) return 'unknown'
  const at = Date.parse(snapshotAt)
  if (!Number.isFinite(at)) return 'unknown'
  return now - at > SNAPSHOT_STALE_AFTER_MS ? 'stale' : 'fresh'
}

/**
 * Floating P/L of open trades = equity - balance from the account snapshot (open trades store no
 * profit). With open trades and a stale/unknown snapshot, equity and balance are both outdated and
 * equal, so the difference is a misleading 0 - return null (shown as an em dash) instead.
 */
export function floatingOpenPnl(input: {
  equity: number | null | undefined
  balance: number | null | undefined
  openCount: number | null | undefined
  snapshotAt: string | null | undefined
  now?: number
}): number | null {
  const { equity, balance, openCount, snapshotAt } = input
  if (equity == null || balance == null || !Number.isFinite(equity) || !Number.isFinite(balance)) return null
  if ((openCount ?? 0) > 0 && snapshotFreshness(snapshotAt, input.now) !== 'fresh') return null
  return Math.round((equity - balance) * 100) / 100
}

// ---------------------------------------------------------------------------
// Step validation
// ---------------------------------------------------------------------------

export type ProviderStep = 1 | 2 | 3 | 4

export function validateProviderStep(
  step: ProviderStep,
  draft: ProviderDraft,
  account: BrokerAccount | null,
): string | null {
  if (step === 1) {
    if (!draft.brokerAccountId || !account) return 'Select the account you want people to copy.'
    const problem = providerAccountIneligibility(account)
    if (problem) return PROVIDER_INELIGIBILITY_COPY[problem]
    if (!draft.accountKind) return 'Select the account type.'
    const detected = resolveSocialAccountMode(account)
    if (draft.accountKind !== 'prop' && draft.accountKind !== detected) {
      return `This account is connected as ${detected === 'demo' ? 'Demo' : 'Live'}. Choose Prop if it is a prop firm account.`
    }
    if (draft.accountKind === 'prop') {
      const firm = draft.propFirmName.trim()
      if (firm.length < 2) return 'Enter the prop firm name.'
      if (firm.length > PROVIDER_PROP_FIRM_MAX) return 'The prop firm name is too long.'
    }
    return null
  }
  if (step === 2) {
    if (draft.priceUsd.trim() === '') return 'Choose Free or enter a monthly price.'
    if (priceInputToCents(draft.priceUsd) == null) return `Enter a price between 0 and ${PROVIDER_MAX_PRICE_USD.toLocaleString('en-US')} with at most two decimals.`
    if (draft.bio.length > PROVIDER_BIO_MAX) return `Keep your bio under ${PROVIDER_BIO_MAX} characters.`
    return null
  }
  if (step === 3) return validateSocialProfileLinks(draft.links)
  return null
}

export function providerSharePath(slug: string): string {
  return `/p/${slug}`
}

export function providerShareUrl(origin: string, slug: string): string {
  return `${origin.replace(/\/+$/, '')}${providerSharePath(slug)}`
}

export function providerShareTargets(url: string, name: string): { key: 'x' | 'telegram' | 'whatsapp'; label: string; href: string }[] {
  const text = `Copy ${name} on TScopier`
  const encodedUrl = encodeURIComponent(url)
  const encodedText = encodeURIComponent(text)
  return [
    { key: 'x', label: 'X', href: `https://twitter.com/intent/tweet?text=${encodedText}&url=${encodedUrl}` },
    { key: 'telegram', label: 'Telegram', href: `https://t.me/share/url?url=${encodedUrl}&text=${encodedText}` },
    { key: 'whatsapp', label: 'WhatsApp', href: `https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}` },
  ]
}

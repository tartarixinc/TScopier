import { peekPostAuthRedirect } from './postAuthRedirect'

const STORAGE_KEY = 'tsc_pending_plan'

export type PendingPlanSelection = {
  plan: 'basic' | 'advanced'
  interval: 'monthly' | 'annual'
  extraAccounts: number
}

export function parsePlanSelectionFromSearch(search: string): PendingPlanSelection | null {
  const params = new URLSearchParams(search.startsWith('?') ? search : `?${search}`)
  const planRaw = (params.get('plan') ?? '').trim().toLowerCase()
  if (planRaw !== 'basic' && planRaw !== 'advanced') return null
  const intervalRaw = (params.get('interval') ?? 'monthly').trim().toLowerCase()
  const interval = intervalRaw === 'annual' ? 'annual' : 'monthly'
  const extraRaw = Number(params.get('extraAccounts') ?? params.get('extra') ?? 0)
  const extraAccounts =
    planRaw === 'advanced' && Number.isFinite(extraRaw) && extraRaw > 0
      ? Math.min(95, Math.floor(extraRaw))
      : 0
  return { plan: planRaw, interval, extraAccounts }
}

export function stashPendingPlanSelection(selection: PendingPlanSelection): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(selection))
  } catch {
    // ignore storage failures
  }
}

export function capturePendingPlanFromUrl(search: string): PendingPlanSelection | null {
  const selection = parsePlanSelectionFromSearch(search)
  if (!selection) return null
  stashPendingPlanSelection(selection)
  return selection
}

export function loadPendingPlanSelection(): PendingPlanSelection | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PendingPlanSelection>
    if (parsed.plan !== 'basic' && parsed.plan !== 'advanced') return null
    const interval = parsed.interval === 'annual' ? 'annual' : 'monthly'
    const extraAccounts =
      parsed.plan === 'advanced'
      && typeof parsed.extraAccounts === 'number'
      && Number.isFinite(parsed.extraAccounts)
      && parsed.extraAccounts > 0
        ? Math.min(95, Math.floor(parsed.extraAccounts))
        : 0
    return { plan: parsed.plan, interval, extraAccounts }
  } catch {
    return null
  }
}

export function clearPendingPlanSelection(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}

/** Build app signup URL that carries plan selection (+ optional referral). */
export function signupUrlWithPlan(selection: PendingPlanSelection, ref?: string | null): string {
  const params = new URLSearchParams()
  params.set('plan', selection.plan)
  params.set('interval', selection.interval)
  if (selection.plan === 'advanced' && selection.extraAccounts > 0) {
    params.set('extraAccounts', String(selection.extraAccounts))
  }
  if (ref?.trim()) params.set('ref', ref.trim())
  return `/signup?${params.toString()}`
}

/** After auth: pending plan → pricing checkout; otherwise dashboard (paywall redirects unpaid). */
export function postAuthAppPath(opts?: { startCheckout?: boolean }): string {
  const pending = loadPendingPlanSelection()
  const wantsCheckout = Boolean(pending || opts?.startCheckout)
  // A pending plan keeps priority; otherwise return the visitor to where they came from (e.g. a provider page).
  let path = wantsCheckout ? '/pricing?startCheckout=1' : peekPostAuthRedirect() ?? '/dashboard'
  // Local dual-shell: keep the app mount even when VITE_DEV_SITE=marketing.
  if (typeof window !== 'undefined') {
    const host = window.location.hostname
    if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost')) {
      const url = new URL(path, 'http://local.invalid')
      url.searchParams.set('site', 'app')
      path = `${url.pathname}${url.search}`
    }
  }
  return path
}

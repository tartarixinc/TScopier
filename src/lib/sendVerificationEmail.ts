/**
 * Sends the branded confirmation email via the send-verification-email edge function.
 * Works with or without a session (Supabase often omits session until email is confirmed).
 */

export type SendVerificationEmailResult =
  | { ok: true; cooldownSeconds: number }
  | {
    ok: false
    error: string
    code?: 'cooldown' | 'rate_limited' | 'error'
    retryAfterSeconds?: number
  }

const COOLDOWN_STORAGE_PREFIX = 'tscopier:verify-email-cooldown:'

function cooldownStorageKey(email: string): string {
  return `${COOLDOWN_STORAGE_PREFIX}${email.trim().toLowerCase()}`
}

/** Seconds left on the client-side resend cooldown for this email (sessionStorage). */
export function readVerificationEmailCooldownSeconds(email: string): number {
  if (!email.trim()) return 0
  try {
    const raw = sessionStorage.getItem(cooldownStorageKey(email))
    if (!raw) return 0
    const until = Number(raw)
    if (!Number.isFinite(until)) return 0
    return Math.max(0, Math.ceil((until - Date.now()) / 1000))
  } catch {
    return 0
  }
}

export function startVerificationEmailCooldown(email: string, seconds: number): void {
  if (!email.trim() || seconds <= 0) return
  try {
    sessionStorage.setItem(
      cooldownStorageKey(email),
      String(Date.now() + seconds * 1000),
    )
  } catch {
    /* ignore quota / private mode */
  }
}

export function clearVerificationEmailCooldown(email: string): void {
  try {
    sessionStorage.removeItem(cooldownStorageKey(email))
  } catch {
    /* ignore */
  }
}

export async function sendVerificationEmail(args: {
  email: string
  accessToken?: string | null
  redirectTo?: string
  captchaToken?: string | null
}): Promise<SendVerificationEmailResult> {
  const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-verification-email`
  const redirectTo = args.redirectTo ?? `${window.location.origin}/dashboard`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
  }
  if (args.accessToken) {
    headers.Authorization = `Bearer ${args.accessToken}`
  } else {
    headers.Authorization = `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`
  }

  const controller = new AbortController()
  const timeoutId = globalThis.setTimeout(() => controller.abort(), 15_000)
  let res: Response
  try {
    res = await fetch(apiUrl, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        email: args.email,
        redirectTo,
        captchaToken: args.captchaToken ?? undefined,
      }),
    })
  } catch {
    return {
      ok: false,
      code: 'error',
      error: 'Could not request a verification email. Please try again.',
    }
  } finally {
    globalThis.clearTimeout(timeoutId)
  }
  const data = (await res.json().catch(() => ({}))) as {
    error?: string
    code?: string
    details?: string
    hint?: string
    message?: string
    retry_after_seconds?: number
    cooldown_seconds?: number
  }

  if (res.status === 429) {
    const code = data.code === 'rate_limited' ? 'rate_limited' : 'cooldown'
    const retryAfterSeconds = Math.max(
      1,
      Number(data.retry_after_seconds ?? 60),
    )
    startVerificationEmailCooldown(args.email, retryAfterSeconds)
    return {
      ok: false,
      code,
      retryAfterSeconds,
      error:
        data.message
        ?? (code === 'rate_limited'
          ? 'Too many verification emails. Try again later.'
          : 'Please wait before requesting another verification email.'),
    }
  }

  if (!res.ok) {
    const msg = [data.error, data.details, data.hint].filter(Boolean).join(' — ')
    return { ok: false, code: 'error', error: msg || `HTTP ${res.status}` }
  }

  const cooldownSeconds = Math.max(1, Number(data.cooldown_seconds ?? 60))
  startVerificationEmailCooldown(args.email, cooldownSeconds)
  return {
    ok: true,
    cooldownSeconds,
  }
}

import crypto from 'node:crypto'
import { SupabaseClient } from '@supabase/supabase-js'
import { TelegramClient } from 'telegram'
import { Api } from 'telegram/tl'
import { computeCheck } from 'telegram/Password'
import { buildClient, isAuthKeyUnregistered, tgInvoke, API_ID, API_HASH } from './telegramClient'
import { UserSessionManager } from './sessionManager'
import type { ChannelInfo } from './userListener'
import {
  assertTelegramAccountAvailable,
  normalizeTelegramPhoneNumber,
  upsertTelegramAccountClaim,
} from './telegramAccountClaims'
import { logTelegramAuthFailure, logTelegramAuthSuccess, persistListenerEvent } from './listenerEvents'
import { buildQrStatusFromPending, formatQrLoginUrl, qrStatusFromActiveSession, type QrStatusResponse } from './telegramQrAuth'
import {
  isPhoneCodeFatalAuthError,
  isRecoverableTelegramAuthError,
  NO_PENDING_PHONE_AUTH_ERROR,
  noPendingPhoneAuthMessage,
} from './telegramAuthRecovery'

type PhonePending = {
  method: 'phone'
  client: TelegramClient
  phone: string
  phoneCodeHash: string
  delivery: TelegramCodeDelivery
  nextDelivery?: TelegramCodeDelivery | null
  timeoutSeconds?: number | null
  resendAvailableAt?: number | null
  canResend?: boolean
  codeLength?: number | null
  createdAt: number
  awaitingPassword?: boolean
}

type QrPending = {
  method: 'qr'
  client: TelegramClient
  latestQrUrl: string
  expiresAt: number
  status: 'waiting' | 'requires_password' | 'success' | 'error'
  createdAt: number
  phone?: string
  error?: string
  result?: { ok: true; session_id: string; channels?: ChannelInfo[] }
  passwordHint?: string
}

type PendingEntry = PhonePending | QrPending

type VerifySuccess = { ok: true; session_id: string; channels?: ChannelInfo[] }

type VerifyResult = VerifySuccess | { requires_password: true }

type TelegramInvoker = <T>(client: TelegramClient, request: Parameters<typeof tgInvoke>[1]) => Promise<T>

type AuthServiceDeps = {
  buildClient?: typeof buildClient
  invoke?: TelegramInvoker
  now?: () => number
}

/**
 * Maximum age of a pending auth (between send_code and verify_code)
 * before we drop the in-memory client. Telegram codes expire in a few minutes;
 * DB-backed recovery lasts slightly longer for cross-replica / slow UX.
 */
const PENDING_TTL_MS = 10 * 60 * 1000
/** Extra in-memory window once Telegram asked for 2FA (user is typing the password). */
const PENDING_PASSWORD_TTL_MS = 20 * 60 * 1000
const CLEANUP_INTERVAL_MS = 60 * 1000
/** DB row outlives Telegram code validity slightly so retries still recover across replicas. */
const PENDING_DB_TTL_MS = 12 * 60 * 1000
/** Ignore a second Send Code click this soon; after this, request a new Telegram code. */
const SEND_CODE_DEBOUNCE_MS = 15 * 1000
/** Longer DB TTL while waiting for Two-Step Verification password. */
const PENDING_DB_PASSWORD_TTL_MS = 20 * 60 * 1000
const QR_FIRST_TOKEN_WAIT_MS = 15_000
const QR_PASSWORD_WAIT_MS = 120_000
export const NO_RESEND_AVAILABLE_ERROR = 'NO_RESEND_AVAILABLE'
/** Maximum time an authInFlight entry can live before it is considered stale and cleaned up. */
const AUTH_IN_FLIGHT_TTL_MS = 2 * 60 * 1000
/** Hard timeout for the entire sendCode / startQrLogin operation (prepareForAuth + client.connect + API call). */
const AUTH_OPERATION_TIMEOUT_MS = 90 * 1000

function withAuthOperationTimeout<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error('AUTH_OPERATION_TIMEOUT')), AUTH_OPERATION_TIMEOUT_MS)
    if (typeof timeout.unref === 'function') timeout.unref()
  })
  return Promise.race([operation, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout)
  })
}

const SENSITIVE_AUTH_LOG_KEY_RE = /(phone_code_hash|phonecodehash|session|string_session|auth_session|auth_key|password|code|token|hash)/i
const PHONE_AUTH_LOG_KEY_RE = /phone/i

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function normalizePhoneNumber(raw: string): string {
  return normalizeTelegramPhoneNumber(raw)
}

function phonesMatch(a: string, b: string): boolean {
  return normalizePhoneNumber(a) === normalizePhoneNumber(b)
}

function normalizeVerificationCode(raw: string): string {
  return String(raw ?? '').replace(/\D/g, '')
}

export type TelegramCodeDelivery = 'app' | 'sms' | 'call' | 'other'

export type TelegramCodeStatus = {
  delivery: TelegramCodeDelivery
  next_delivery?: TelegramCodeDelivery | null
  resend_available_at?: string | null
  resend_wait_seconds?: number | null
  can_resend: boolean
  code_length?: number | null
}

/** Map Telegram SentCode type to a simple delivery channel for the UI. */
export function sentCodeDelivery(result: { type?: { className?: string } | null }): TelegramCodeDelivery {
  const className = String((result.type as { className?: string } | undefined)?.className ?? '')
  if (/App/i.test(className)) return 'app'
  if (/Sms|Firebase/i.test(className)) return 'sms'
  if (/Call|Flash|MissedCall/i.test(className)) return 'call'
  return 'other'
}

function codeTypeDelivery(value: { className?: string } | null | undefined): TelegramCodeDelivery | null {
  const className = String(value?.className ?? '')
  if (!className) return null
  if (/Sms|Firebase/i.test(className)) return 'sms'
  if (/Call|Flash|MissedCall/i.test(className)) return 'call'
  return 'other'
}

function codeLength(value: { length?: unknown } | null | undefined): number | null {
  const length = value?.length
  return typeof length === 'number' && Number.isFinite(length) && length > 0 ? length : null
}

function telegramConstructorName(value: { className?: unknown } | null | undefined): string {
  const className = typeof value?.className === 'string' ? value.className : ''
  return className || 'absent'
}

function telegramErrorMeta(err: unknown): { apiErrorClass: string; apiErrorCode: string } {
  const rec = err as { name?: unknown; code?: unknown; errorCode?: unknown; errorMessage?: unknown } | null | undefined
  return {
    apiErrorClass: err instanceof Error ? err.name : typeof rec?.name === 'string' ? rec.name : 'unknown',
    apiErrorCode: String(rec?.code ?? rec?.errorCode ?? rec?.errorMessage ?? ''),
  }
}

function positiveSeconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.ceil(value) : null
}

function pendingCanResend(pending: Pick<PhonePending, 'canResend' | 'nextDelivery' | 'timeoutSeconds' | 'resendAvailableAt'>): boolean {
  return Boolean(pending.canResend || (pending.nextDelivery && pending.timeoutSeconds && pending.resendAvailableAt))
}

export function sentCodeStatus(
  result: {
    type?: { className?: string; length?: unknown } | null
    nextType?: { className?: string } | null
    timeout?: unknown
  },
  now = Date.now(),
): Omit<TelegramCodeStatus, 'resend_available_at' | 'resend_wait_seconds'> & {
  timeoutSeconds: number | null
  resendAvailableAt: number | null
  canResend: boolean
} {
  const timeoutSeconds = positiveSeconds(result.timeout)
  const nextDelivery = codeTypeDelivery(result.nextType)
  const canResend = nextDelivery !== null && timeoutSeconds !== null
  return {
    delivery: sentCodeDelivery(result),
    next_delivery: nextDelivery,
    timeoutSeconds,
    resendAvailableAt: canResend ? now + timeoutSeconds * 1000 : null,
    can_resend: canResend,
    canResend,
    code_length: codeLength(result.type),
  }
}

function pendingCodeStatus(pending: PhonePending, now = Date.now()): TelegramCodeStatus {
  const waitMs = pending.resendAvailableAt ? Math.max(0, pending.resendAvailableAt - now) : 0
  const canResend = pendingCanResend(pending)
  return {
    delivery: pending.delivery,
    next_delivery: pending.nextDelivery ?? null,
    resend_available_at: canResend && pending.resendAvailableAt ? new Date(pending.resendAvailableAt).toISOString() : null,
    resend_wait_seconds: canResend && pending.resendAvailableAt ? Math.ceil(waitMs / 1000) : null,
    can_resend: canResend,
    code_length: pending.codeLength ?? null,
  }
}

type PhoneAuthSessionEnvelope = {
  version: 1
  session: string
  delivery?: TelegramCodeDelivery | null
  nextDelivery?: TelegramCodeDelivery | null
  timeoutSeconds?: number | null
  resendAvailableAt?: number | null
  canResend?: boolean
  codeLength?: number | null
  createdAt?: number
}

function parsePhoneAuthSessionEnvelope(raw: string): { sessionString: string; meta: Partial<PhoneAuthSessionEnvelope> } {
  try {
    const parsed = JSON.parse(raw) as Partial<PhoneAuthSessionEnvelope>
    if (parsed && parsed.version === 1 && typeof parsed.session === 'string') {
      return { sessionString: parsed.session, meta: parsed }
    }
  } catch {
    /* Legacy rows stored the raw StringSession. */
  }
  return { sessionString: raw, meta: {} }
}

function serializePhoneAuthSession(sessionString: string, pending: PhonePending): string {
  const envelope: PhoneAuthSessionEnvelope = {
    version: 1,
    session: sessionString,
    delivery: pending.delivery,
    nextDelivery: pending.nextDelivery ?? null,
    timeoutSeconds: pending.timeoutSeconds ?? null,
    resendAvailableAt: pending.resendAvailableAt ?? null,
    canResend: Boolean(pending.canResend),
    codeLength: pending.codeLength ?? null,
    createdAt: pending.createdAt,
  }
  return JSON.stringify(envelope)
}

function shortHash(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(String(value ?? ''))
    .digest('hex')
    .slice(0, 12)
}

export function redactAuthLogValue(key: string, value: unknown): string {
  if (/^(code_length|codeLength|apiErrorCode)$/i.test(key)) return String(value ?? '')
  if (SENSITIVE_AUTH_LOG_KEY_RE.test(key)) return '[redacted]'
  if (PHONE_AUTH_LOG_KEY_RE.test(key)) return `[phone:${shortHash(value)}]`
  if (typeof value === 'object' && value !== null) return JSON.stringify(value)
  return String(value ?? '')
}

function logAuthEvent(event: string, extra?: Record<string, unknown>): void {
  const parts = [`[authService] event=${event}`]
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      parts.push(`${k}=${redactAuthLogValue(k, v)}`)
    }
  }
  console.log(parts.join(' '))
}

function authCorrelationId(): string {
  return crypto.randomUUID().slice(0, 8)
}

/**
 * Owns the MTProto connection during the send_code -> verify_code window.
 * The same TelegramClient is kept alive across both calls so we never re-auth
 * to a different DC. On success the live client is handed off to the
 * UserSessionManager and becomes the long-running listener client — there
 * is exactly one TCP connection per user from auth onward.
 */
export class AuthService {
  private pending = new Map<string, PendingEntry>()
  /** True from auth start until pending Map entry is ready — blocks listener restart. */
  private authInFlight = new Set<string>()
  /** Timestamps for authInFlight entries so stale ones can be evicted. */
  private authInFlightTimestamps = new Map<string, number>()
  private resendInFlight = new Set<string>()
  private qrPasswordResolvers = new Map<string, { resolve: (p: string) => void; reject: (e: Error) => void }>()
  private cleanupTimer: NodeJS.Timeout
  private readonly createTelegramClient: typeof buildClient
  private readonly invokeTelegram: TelegramInvoker
  private readonly now: () => number

  constructor(
    private supabase: SupabaseClient,
    private sessionManager: UserSessionManager,
    deps: AuthServiceDeps = {},
  ) {
    this.createTelegramClient = deps.buildClient ?? buildClient
    this.invokeTelegram = deps.invoke ?? tgInvoke
    this.now = deps.now ?? Date.now
    this.sessionManager.setAuthGuard(
      userId => this.pending.has(userId) || this.isAuthInFlight(userId) || this.resendInFlight.has(userId),
    )
    this.cleanupTimer = setInterval(() => {
      this.cleanup()
      if (this.pending.size > 0) {
        const oldestAge = Math.max(0, ...Array.from(this.pending.values()).map(p => Date.now() - p.createdAt))
        logAuthEvent('auth_heartbeat', {
          pendingCount: this.pending.size,
          inFlightCount: this.authInFlight.size,
          oldestPendingAgeMs: oldestAge,
        })
      }
    }, CLEANUP_INTERVAL_MS)
    if (typeof this.cleanupTimer.unref === 'function') this.cleanupTimer.unref()
  }

  async shutdown(): Promise<void> {
    clearInterval(this.cleanupTimer)
    const disconnects = [...this.pending.entries()].map(async ([userId, p]) => {
      try {
        await p.client.disconnect()
      } catch (err) {
        console.warn(
          `[authService] pending auth disconnect failed for user ${userId}:`,
          err instanceof Error ? err.message : err,
        )
      }
    })
    await Promise.allSettled(disconnects)
    this.pending.clear()
    this.authInFlight.clear()
    this.authInFlightTimestamps.clear()
    this.resendInFlight.clear()
    this.qrPasswordResolvers.clear()
  }

  private pendingTtlMs(p: PendingEntry): number {
    if (p.method === 'phone' && p.awaitingPassword) return PENDING_PASSWORD_TTL_MS
    if (p.method === 'qr' && p.status === 'requires_password') return PENDING_PASSWORD_TTL_MS
    return PENDING_TTL_MS
  }

  /**
   * Returns true if the user has a live authInFlight entry. If the entry is stale
   * (older than AUTH_IN_FLIGHT_TTL_MS), it is evicted and this returns false.
   */
  private isAuthInFlight(userId: string): boolean {
    if (!this.authInFlight.has(userId)) return false
    const createdAt = this.authInFlightTimestamps.get(userId) ?? 0
    const age = this.now() - createdAt
    if (age > AUTH_IN_FLIGHT_TTL_MS) {
      logAuthEvent('auth_in_flight_stale_evict', { userId, ageMs: age })
      console.warn(`[authService] evicting stale authInFlight entry for user ${userId} (age ${age}ms)`)
      this.authInFlight.delete(userId)
      this.authInFlightTimestamps.delete(userId)
      return false
    }
    return true
  }

  private markAuthInFlight(userId: string): void {
    this.authInFlight.add(userId)
    this.authInFlightTimestamps.set(userId, this.now())
  }

  private clearAuthInFlight(userId: string): void {
    this.authInFlight.delete(userId)
    this.authInFlightTimestamps.delete(userId)
  }

  private cleanup() {
    const now = Date.now()
    for (const [userId, p] of this.pending) {
      if (now - p.createdAt > this.pendingTtlMs(p)) {
        p.client.disconnect().catch(() => {})
        this.pending.delete(userId)
        this.qrPasswordResolvers.delete(userId)
        console.log(`[authService] expired pending auth for user ${userId}`)
      }
    }
    // Evict stale authInFlight entries that were never cleaned up (e.g. hung promise).
    for (const [userId, createdAt] of this.authInFlightTimestamps) {
      if (now - createdAt > AUTH_IN_FLIGHT_TTL_MS) {
        console.warn(`[authService] cleanup evicting stale authInFlight for user ${userId} (age ${now - createdAt}ms)`)
        this.authInFlight.delete(userId)
        this.authInFlightTimestamps.delete(userId)
      }
    }
    void this.supabase
      .from('telegram_auth_pending')
      .delete()
      .lt('expires_at', new Date(now).toISOString())
      .then(({ error }) => {
        if (error) console.warn('[authService] telegram_auth_pending cleanup:', error.message)
      })
  }

  private async clearPendingRow(userId: string, source = 'unspecified') {
    console.log(`[authService] clearPendingRow user=${userId} source=${source}`)
    await this.supabase.from('telegram_auth_pending').delete().eq('user_id', userId)
  }

  private async disconnectPending(userId: string, source = 'unspecified') {
    const existing = this.pending.get(userId)
    console.log(`[authService] disconnectPending user=${userId} source=${source} has_pending=${!!existing}`)
    if (existing) {
      try { await existing.client.disconnect() } catch { /* ignore */ }
      this.pending.delete(userId)
    }
    this.qrPasswordResolvers.delete(userId)
  }

  /**
   * When verify hits a different process than send_code, rebuild MTProto from the
   * persisted phone_code_hash (same approach as reconnecting after app restart).
   */
  private async restorePhonePendingFromDatabase(userId: string, phone: string): Promise<PhonePending | null> {
    const { data: row, error } = await this.supabase
      .from('telegram_auth_pending')
      .select('phone, phone_code_hash, expires_at, awaiting_password, auth_session_string, auth_method')
      .eq('user_id', userId)
      .maybeSingle()

    if (error || !row) return null
    // Only restore real phone auth rows — never QR or ephemeral MTProto holds.
    if (row.auth_method && row.auth_method !== 'phone') return null
    if (!row.phone_code_hash) return null
    if (new Date(row.expires_at) < new Date()) {
      await this.clearPendingRow(userId)
      return null
    }
    if (!row.phone || !phonesMatch(row.phone, phone)) {
      console.warn(`[authService] verify phone mismatch for user ${userId}`)
      return null
    }

    const awaitingPassword = Boolean(row.awaiting_password)
    const savedAuthSession =
      typeof row.auth_session_string === 'string' && row.auth_session_string.trim()
        ? row.auth_session_string.trim()
        : ''
    const { sessionString: savedSession, meta } = parsePhoneAuthSessionEnvelope(savedAuthSession)

    // 2FA resume requires the persisted MTProto session from SignIn; without it the
    // user must request a new code.
    if (awaitingPassword && !savedSession) {
      console.warn(`[authService] awaiting password but missing auth_session_string for ${userId}`)
      return null
    }

    const client = this.createTelegramClient(savedSession)
    await client.connect()
    return {
      method: 'phone',
      client,
      phone: row.phone,
      phoneCodeHash: row.phone_code_hash ?? '',
      delivery: meta.delivery ?? 'other',
      nextDelivery: meta.nextDelivery ?? null,
      timeoutSeconds: meta.timeoutSeconds ?? null,
      resendAvailableAt: meta.resendAvailableAt ?? null,
      canResend: Boolean(meta.canResend || (meta.nextDelivery && meta.timeoutSeconds && meta.resendAvailableAt)),
      codeLength: meta.codeLength ?? null,
      createdAt: typeof meta.createdAt === 'number' && meta.createdAt > 0 ? meta.createdAt : 0,
      awaitingPassword,
    }
  }

  private async getPhonePending(userId: string, phone: string): Promise<PhonePending | null> {
    const existing = this.pending.get(userId)
    if (existing?.method === 'phone') {
      return phonesMatch(existing.phone, phone) ? existing : null
    }
    const restored = await this.restorePhonePendingFromDatabase(userId, phone)
    if (restored) this.pending.set(userId, restored)
    return restored
  }

  private async restoreQrPendingFromDatabase(userId: string): Promise<QrPending | null> {
    const { data: row, error } = await this.supabase
      .from('telegram_auth_pending')
      .select('expires_at, auth_session_string, awaiting_password, qr_expires_at, phone, auth_method')
      .eq('user_id', userId)
      .maybeSingle()

    if (error || !row || row.auth_method !== 'qr') return null
    if (new Date(row.expires_at) < new Date()) {
      await this.clearPendingRow(userId)
      return null
    }

    const sessionString =
      typeof row.auth_session_string === 'string' && row.auth_session_string.trim()
        ? row.auth_session_string.trim()
        : ''
    if (!sessionString) return null

    const client = this.createTelegramClient(sessionString)
    await client.connect()
    const pending: QrPending = {
      method: 'qr',
      client,
      latestQrUrl: '',
      expiresAt: row.qr_expires_at ? new Date(row.qr_expires_at).getTime() : 0,
      status: row.awaiting_password ? 'requires_password' : 'waiting',
      createdAt: Date.now(),
      phone: row.phone ?? undefined,
    }
    if (pending.status === 'waiting') {
      void this.runQrLoginBackground(userId, pending)
    }
    return pending
  }

  private async persistAwaitingPassword(
    userId: string,
    client: TelegramClient,
    pending?: PhonePending,
  ): Promise<void> {
    const authSessionString = (client.session.save() as unknown) as string
    const expiresAt = new Date(Date.now() + PENDING_DB_PASSWORD_TTL_MS).toISOString()
    // Upsert: a plain UPDATE matches 0 rows if cleanup deleted the send_code row mid-flight.
    const { error } = await this.supabase.from('telegram_auth_pending').upsert(
      {
        user_id: userId,
        auth_method: 'phone',
        phone: pending?.phone ?? null,
        phone_code_hash: pending?.phoneCodeHash ?? null,
        expires_at: expiresAt,
        awaiting_password: true,
        auth_session_string: pending ? serializePhoneAuthSession(authSessionString, pending) : authSessionString,
      },
      { onConflict: 'user_id' },
    )
    if (error) {
      console.warn(`[authService] persistAwaitingPassword failed for ${userId}:`, error.message)
    }
    if (pending) {
      pending.awaitingPassword = true
      // Refresh in-memory age so cleanup does not expire mid-password entry.
      pending.createdAt = this.now()
    }
  }

  private async persistPhonePendingRow(userId: string, pending: PhonePending): Promise<void> {
    const authSessionString = (pending.client.session.save() as unknown) as string
    const expiresAt = new Date(Date.now() + PENDING_DB_TTL_MS).toISOString()
    const { error } = await this.supabase.from('telegram_auth_pending').upsert(
      {
        user_id: userId,
        auth_method: 'phone',
        phone: pending.phone,
        phone_code_hash: pending.phoneCodeHash,
        expires_at: expiresAt,
        awaiting_password: Boolean(pending.awaitingPassword),
        auth_session_string: serializePhoneAuthSession(authSessionString, pending),
        qr_expires_at: null,
      },
      { onConflict: 'user_id' },
    )
    if (error) {
      logAuthEvent('phone_pending_upsert_failed', { userId, error: error.message })
      throw new Error('Could not save Telegram login state. Please request a new code.')
    }
  }

  private async persistQrPendingRow(userId: string, client: TelegramClient, pending: QrPending): Promise<void> {
    const authSessionString = (client.session.save() as unknown) as string
    const expiresAt = new Date(Date.now() + PENDING_DB_TTL_MS).toISOString()
    const { error } = await this.supabase.from('telegram_auth_pending').upsert(
      {
        user_id: userId,
        auth_method: 'qr',
        phone: pending.phone ?? null,
        phone_code_hash: null,
        expires_at: expiresAt,
        auth_session_string: authSessionString,
        awaiting_password: pending.status === 'requires_password',
        qr_expires_at: pending.expiresAt > 0 ? new Date(pending.expiresAt).toISOString() : null,
      },
      { onConflict: 'user_id' },
    )
    if (error) {
      console.warn(`[authService] persistQrPendingRow failed for ${userId}:`, error.message)
    }
  }

  private async completePasswordStep(client: TelegramClient, password: string): Promise<void> {
    const srpResult = await this.invokeTelegram<Api.account.Password>(client, new Api.account.GetPassword())
    const srpCheck = await computeCheck(srpResult, password)
    await this.invokeTelegram(client, new Api.auth.CheckPassword({ password: srpCheck }))
  }

  private async finalizeAuth(
    client: TelegramClient,
    userId: string,
    phone: string,
    correlationId?: string,
    method: 'phone' | 'qr' = 'phone',
  ): Promise<VerifySuccess> {
    const sessionString = (client.session.save() as unknown) as string
    logAuthEvent('finalize_auth_start', { userId, phone, correlationId })
    const tStart = Date.now()

    const me = await client.getMe()
    const telegramUserId = me.id?.toString?.() ?? String(me.id)
    logAuthEvent('finalize_auth_got_user', { userId, telegramUserId, correlationId })
    await assertTelegramAccountAvailable(this.supabase, userId, {
      phone,
      telegramUserId,
    })

    const { data: row, error: dbErr } = await this.supabase
      .from('telegram_sessions')
      .upsert({
        user_id: userId,
        session_string: sessionString,
        phone_number: phone,
        is_active: true,
        listener_engine: 'gramjs',
      }, { onConflict: 'user_id' })
      .select('id')
      .single()

    if (dbErr || !row) {
      logAuthEvent('finalize_auth_db_failed', { userId, correlationId, error: dbErr?.message ?? 'no row returned', timeMs: Date.now() - tStart })
      console.error(`[authService] finalizeAuth db_upsert_failed user=${userId}: ${dbErr?.message ?? 'no row returned'}`)
      logTelegramAuthFailure(this.supabase, userId, 'finalize', dbErr?.message ?? 'Failed to persist session')
      try { await client.disconnect() } catch { /* ignore */ }
      await this.clearPendingRow(userId, 'finalizeAuth_db_fail')
      throw new Error(dbErr?.message ?? 'Failed to persist Telegram session')
    }

    try {
      await upsertTelegramAccountClaim(this.supabase, userId, {
        phone,
        telegramUserId,
      })
      logAuthEvent('finalize_auth_claim_ok', { userId, telegramUserId, correlationId })
    } catch (claimErr) {
      logAuthEvent('finalize_auth_claim_failed', { userId, correlationId, error: claimErr instanceof Error ? claimErr.message : String(claimErr) })
      console.error(`[authService] finalizeAuth claim_failed user=${userId}:`, claimErr instanceof Error ? claimErr.message : claimErr)
      logTelegramAuthFailure(this.supabase, userId, 'finalize', claimErr instanceof Error ? claimErr.message : String(claimErr))
      await this.supabase.from('telegram_sessions').delete().eq('user_id', userId)
      try { await client.disconnect() } catch { /* ignore */ }
      await this.clearPendingRow(userId, 'finalizeAuth_claim_fail')
      throw claimErr
    }

    this.pending.delete(userId)
    await this.clearPendingRow(userId, 'finalizeAuth_success')
    let channels: ChannelInfo[] | undefined
    try {
      logAuthEvent('finalize_auth_adopting', { userId, correlationId })
      await this.sessionManager.adoptClient(userId, client, sessionString)
      try {
        channels = await this.sessionManager.listChannelsForAdoptedUser(userId, { skipColdDelay: true })
        logAuthEvent('finalize_auth_channels_ok', { userId, channelCount: channels?.length ?? 0, correlationId })
      } catch (listErr) {
        logAuthEvent('finalize_auth_channels_failed', { userId, correlationId, error: listErr instanceof Error ? listErr.message : String(listErr) })
        console.warn(`[authService] listChannels after auth failed for ${userId}:`, listErr)
      }
    } catch (err) {
      logAuthEvent('finalize_auth_adopt_failed', { userId, correlationId, error: err instanceof Error ? err.message : String(err) })
      console.error(`[authService] adoptClient failed for ${userId}:`, err)
      try {
        await client.disconnect()
      } catch {
        /* ignore */
      }
    }

    logAuthEvent('finalize_auth_complete', { userId, sessionId: row.id, totalTimeMs: Date.now() - tStart, correlationId })
    void persistListenerEvent(this.supabase, {
      userId,
      eventType: 'telegram_link_success',
      detail: { session_id: row.id, method },
    })
    return { ok: true, session_id: row.id as string, channels }
  }

  private async runQrLoginBackground(userId: string, pending: QrPending, correlationId = authCorrelationId()): Promise<void> {
    const { client } = pending
    logAuthEvent('qr_login_bg_start', { userId, correlationId })
    try {
      await client.signInUserWithQrCode(
        { apiId: API_ID, apiHash: API_HASH },
        {
          qrCode: async ({ token, expires }) => {
            pending.latestQrUrl = formatQrLoginUrl(
              Buffer.isBuffer(token) ? token : Buffer.from(token as Uint8Array),
            )
            pending.expiresAt = expires * 1000
            console.log(`[authService] QR token received user=${userId} expires_at=${pending.expiresAt}`)
            await this.persistQrPendingRow(userId, client, pending)
          },
          password: async (hint?: string) => {
            console.log(`[authService] QR requires password user=${userId} hint=${hint ?? 'none'}`)
            pending.status = 'requires_password'
            pending.passwordHint = hint
            await this.persistAwaitingPassword(userId, client)
            return new Promise<string>((resolve, reject) => {
              this.qrPasswordResolvers.set(userId, { resolve, reject })
            })
          },
          onError: async (err: Error) => {
            console.warn(`[authService] QR login onError user=${userId}:`, err.message)
            if (isAuthKeyUnregistered(err)) {
              throw new Error('AUTH_KEY_UNREGISTERED')
            }
            return false
          },
        },
      )

      console.log(`[authService] QR signIn completed user=${userId} — calling finalizeAuth`)
      const me = await client.getMe()
      const phone = me.phone ? normalizePhoneNumber(`+${me.phone}`) : pending.phone ?? ''
      pending.phone = phone
      // Mark success only after finalizeAuth returns. finalizeAuth clears the Map
      // entry — re-attach so the next poll can observe success without racing.
      const result = await this.finalizeAuth(client, userId, phone || `tg:${me.id}`, correlationId, 'qr')
      pending.status = 'success'
      pending.result = result
      this.pending.set(userId, pending)
      logAuthEvent('qr_login_succeeded', { userId, correlationId })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      pending.status = 'error'
      pending.error = msg
      console.error(`[authService] QR login failed user=${userId} error=${msg}`)
      try { await client.disconnect() } catch { /* ignore */ }
      // Keep pending entry with error status so getQrStatus poll can surface
      // the specific error (e.g. TELEGRAM_ALREADY_LINKED) to the frontend.
      // Cleanup happens on next auth attempt or periodic cleanup.
      await this.clearPendingRow(userId)
    }
  }

  private async getOrRestoreQrPending(userId: string): Promise<QrPending | null> {
    const existing = this.pending.get(userId)
    if (existing?.method === 'qr') return existing
    const restored = await this.restoreQrPendingFromDatabase(userId)
    if (restored) {
      this.pending.set(userId, restored)
      return restored
    }
    return null
  }

  async sendCode(
    userId: string,
    phone: string,
  ): Promise<TelegramCodeStatus> {
    const correlationId = authCorrelationId()
    const normalizedPhone = normalizePhoneNumber(phone)
    logAuthEvent('send_code_start', { userId, rawPhone: phone, normalizedPhone, correlationId })
    if (!normalizedPhone || !normalizedPhone.startsWith('+')) {
      logAuthEvent('send_code_invalid_phone', { userId, phone, correlationId })
      console.warn(`[authService] send_code invalid phone format user=${userId} phone=${redactAuthLogValue('phone', phone)}`)
      logTelegramAuthFailure(this.supabase, userId, 'send_code', 'Invalid phone format')
      throw new Error('Use full phone with country code, e.g. +44...')
    }
    if (this.isAuthInFlight(userId)) {
      logAuthEvent('send_code_duplicate_in_flight', { userId, correlationId })
      logTelegramAuthFailure(this.supabase, userId, 'send_code', 'Duplicate in flight')
      throw new Error('Telegram login is already starting. Wait a few seconds before requesting another code.')
    }
    await assertTelegramAccountAvailable(this.supabase, userId, { phone: normalizedPhone })
    const existingPending = await this.getPhonePending(userId, normalizedPhone)
    if (existingPending) {
      if (existingPending.awaitingPassword) {
        throw new Error('Telegram Two-Step Verification password is already required for this login.')
      }
      const ageMs = this.now() - existingPending.createdAt
      if (existingPending.createdAt > 0 && ageMs >= 0 && ageMs < SEND_CODE_DEBOUNCE_MS) {
        const status = pendingCodeStatus(existingPending, this.now())
        logAuthEvent('send_code_existing_pending', {
          userId,
          correlationId,
          delivery: status.delivery,
          nextDelivery: status.next_delivery,
          resendWaitSeconds: status.resend_wait_seconds,
          pendingAgeMs: ageMs,
        })
        return status
      }
      logAuthEvent('send_code_retry_fresh', {
        userId,
        correlationId,
        pendingAgeMs: existingPending.createdAt > 0 ? ageMs : null,
      })
    }

    this.markAuthInFlight(userId)
    const tStart = Date.now()
    try {
      await this.disconnectPending(userId, 'send_code')

      // Upsert placeholder first so there is never an empty-pending window that
      // lets onAuthPendingCleared / syncSessions restart the old live session
      // (which would swallow the in-app login code).
      const placeholderExpires = new Date(Date.now() + PENDING_DB_TTL_MS).toISOString()
      const { error: holdErr } = await this.supabase.from('telegram_auth_pending').upsert(
        {
          user_id: userId,
          auth_method: 'phone',
          phone: normalizedPhone,
          phone_code_hash: null,
          expires_at: placeholderExpires,
          awaiting_password: false,
          auth_session_string: null,
          qr_expires_at: null,
        },
        { onConflict: 'user_id' },
      )
      if (holdErr) {
        logAuthEvent('send_code_hold_failed', { userId, correlationId, error: holdErr.message })
        console.error('[authService] auth hold upsert failed:', holdErr.message)
        logTelegramAuthFailure(this.supabase, userId, 'send_code', 'Could not save login state')
        throw new Error('Could not start Telegram login. Try again in a minute.')
      }

      // Wrap prepareForAuth + connect + API call in a hard timeout so a hung
      // promise (e.g. deadlock in prepareForAuth) does not leave authInFlight
      // stuck forever.
      const innerResult = await withAuthOperationTimeout((async () => {
          await this.sessionManager.prepareForAuth(userId)

          const client = this.createTelegramClient('')
          logAuthEvent('send_code_connecting', { userId, correlationId })
          await client.connect()
          logAuthEvent('send_code_connected', { userId, correlationId, connectTimeMs: Date.now() - tStart })

          try {
            const tApi = Date.now()
            logAuthEvent('send_code_calling_api', { userId, normalizedPhone, correlationId })
            const result = await this.invokeTelegram<Api.auth.SentCode>(
              client,
              new Api.auth.SendCode({
                phoneNumber: normalizedPhone,
                apiId: API_ID,
                apiHash: API_HASH,
                settings: new Api.CodeSettings({
                  allowFlashcall: false,
                  currentNumber: true,
                  allowAppHash: true,
                  allowMissedCall: false,
                  allowFirebase: false,
                }),
              }),
            )
            const status = sentCodeStatus(result, this.now())
            logAuthEvent('send_code_api_ok', {
              userId, correlationId, apiTimeMs: Date.now() - tApi,
              responseType: telegramConstructorName(result),
              delivery: status.delivery,
              deliveryType: telegramConstructorName(result.type),
              nextDelivery: status.next_delivery,
              nextDeliveryType: telegramConstructorName(result.nextType),
              timeoutPresent: typeof result.timeout === 'number',
              timeoutSeconds: status.timeoutSeconds,
              codeLength: status.code_length,
              canResend: status.can_resend,
            })

            const pending: PhonePending = {
              method: 'phone',
              client,
              phone: normalizedPhone,
              phoneCodeHash: result.phoneCodeHash,
              delivery: status.delivery,
              nextDelivery: status.next_delivery ?? null,
              timeoutSeconds: status.timeoutSeconds,
              resendAvailableAt: status.resendAvailableAt,
              canResend: status.canResend,
              codeLength: status.code_length ?? null,
              createdAt: this.now(),
            }
            this.pending.set(userId, pending)
            await this.persistPhonePendingRow(userId, pending)

            logAuthEvent('send_code_complete', { userId, correlationId, totalTimeMs: Date.now() - tStart })
            return pendingCodeStatus(pending, this.now())
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err)
            logAuthEvent('send_code_api_failed', {
              userId,
              correlationId,
              error: errMsg,
              ...telegramErrorMeta(err),
              totalTimeMs: Date.now() - tStart,
            })
            console.warn(`[authService] send_code Telegram API failed user=${userId}:`, errMsg)
            logTelegramAuthFailure(this.supabase, userId, 'send_code', errMsg)
            try { await client.disconnect() } catch { /* ignore */ }
            this.pending.delete(userId)
            await this.clearPendingRow(userId)
            throw err
          }
        })())
      return innerResult
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      if (errMsg === 'AUTH_OPERATION_TIMEOUT') {
        logAuthEvent('send_code_timeout', { userId, correlationId, totalTimeMs: Date.now() - tStart })
        console.warn(`[authService] send_code timed out for user ${userId} after ${Date.now() - tStart}ms`)
        logTelegramAuthFailure(this.supabase, userId, 'send_code', 'Operation timed out')
      }
      throw err
    } finally {
      this.clearAuthInFlight(userId)
    }
  }

  async resendCode(userId: string, phone: string): Promise<TelegramCodeStatus> {
    const correlationId = authCorrelationId()
    const normalizedPhone = normalizePhoneNumber(phone)
    logAuthEvent('resend_code_start', { userId, normalizedPhone, correlationId })
    if (!normalizedPhone || !normalizedPhone.startsWith('+')) {
      logAuthEvent('resend_code_invalid_phone', { userId, phone, correlationId })
      throw new Error('Use full phone with country code, e.g. +44...')
    }
    if (this.isAuthInFlight(userId)) {
      throw new Error('Telegram login is already starting. Wait a few seconds before requesting another code.')
    }

    const pending = await this.getPhonePending(userId, normalizedPhone)
    if (!pending) {
      logAuthEvent('resend_code_no_pending', { userId, correlationId })
      const err = new Error(noPendingPhoneAuthMessage())
      err.name = NO_PENDING_PHONE_AUTH_ERROR
      throw err
    }
    if (pending.awaitingPassword) {
      throw new Error('Telegram Two-Step Verification password is already required for this login.')
    }

    const now = this.now()
    if (!pendingCanResend(pending) || !pending.nextDelivery || !pending.resendAvailableAt) {
      logAuthEvent('resend_code_unavailable', {
        userId,
        correlationId,
        delivery: pending.delivery,
        nextDelivery: pending.nextDelivery,
        timeoutSeconds: pending.timeoutSeconds,
        canResend: pendingCanResend(pending),
      })
      throw new Error(NO_RESEND_AVAILABLE_ERROR)
    }
    const waitMs = pending.resendAvailableAt ? pending.resendAvailableAt - now : 0
    if (waitMs > 0) {
      const waitSeconds = Math.ceil(waitMs / 1000)
      logAuthEvent('resend_code_wait', { userId, correlationId, waitSeconds })
      throw new Error(`RESEND_WAIT_${waitSeconds}`)
    }
    if (this.resendInFlight.has(userId)) {
      logAuthEvent('resend_code_duplicate_in_flight', { userId, correlationId })
      throw new Error('Telegram resend is already in progress. Wait a few seconds before requesting another delivery method.')
    }

    this.resendInFlight.add(userId)
    try {
      const { client, phone: pendingPhone, phoneCodeHash } = pending
      if (!client.connected) {
        logAuthEvent('resend_code_reconnect_client', { userId, correlationId })
        try { await client.connect() } catch { /* will fail at invoke */ }
      }

      const tApi = Date.now()
      const result = await this.invokeTelegram<Api.auth.SentCode>(
        client,
        new Api.auth.ResendCode({
          phoneNumber: pendingPhone,
          phoneCodeHash,
        }),
      )
      const status = sentCodeStatus(result, this.now())
      pending.phoneCodeHash = result.phoneCodeHash
      pending.delivery = status.delivery
      pending.nextDelivery = status.next_delivery ?? null
      pending.timeoutSeconds = status.timeoutSeconds
      pending.resendAvailableAt = status.resendAvailableAt
      pending.canResend = status.canResend
      pending.codeLength = status.code_length ?? null
      pending.createdAt = this.now()
      await this.persistPhonePendingRow(userId, pending)

      logAuthEvent('resend_code_api_ok', {
        userId,
        correlationId,
        apiTimeMs: Date.now() - tApi,
        responseType: telegramConstructorName(result),
        delivery: pending.delivery,
        deliveryType: telegramConstructorName(result.type),
        nextDelivery: pending.nextDelivery,
        nextDeliveryType: telegramConstructorName(result.nextType),
        timeoutPresent: typeof result.timeout === 'number',
        timeoutSeconds: pending.timeoutSeconds,
        codeLength: pending.codeLength,
        canResend: Boolean(pending.canResend),
      })
      return pendingCodeStatus(pending, this.now())
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      logAuthEvent('resend_code_failed', { userId, correlationId, error: errMsg, ...telegramErrorMeta(err) })
      throw err
    } finally {
      this.resendInFlight.delete(userId)
    }
  }

  async verifyCode(userId: string, phone: string, code: string, password?: string): Promise<VerifyResult> {
    const correlationId = authCorrelationId()
    const normalizedPhone = normalizePhoneNumber(phone)
    const normalizedCode = normalizeVerificationCode(code)
    logAuthEvent('verify_code_start', { userId, correlationId, hasCode: !!normalizedCode, hasPassword: !!password })
    if (!normalizedCode) {
      logAuthEvent('verify_code_missing', { userId, correlationId })
      logTelegramAuthFailure(this.supabase, userId, 'verify_code', 'Missing code')
      throw new Error('Verification code is required')
    }
    await this.sessionManager.pauseForAuth(userId, { releaseDelay: false })

    let pending: PhonePending | undefined
    const mem = this.pending.get(userId)
    if (mem?.method === 'phone') pending = mem
    if (!pending) {
      const restored = await this.restorePhonePendingFromDatabase(userId, normalizedPhone)
      if (restored) {
        logAuthEvent('verify_code_restored_db', { userId, correlationId })
        pending = restored
        this.pending.set(userId, restored)
      }
    }
    if (!pending) {
      logAuthEvent('verify_code_no_pending', { userId, correlationId })
      console.warn(`[authService] verifyCode no pending user=${userId}`)
      logTelegramAuthFailure(this.supabase, userId, 'verify_code', 'No pending auth session')
      const err = new Error(noPendingPhoneAuthMessage())
      err.name = NO_PENDING_PHONE_AUTH_ERROR
      throw err
    }

    const { client, phone: pendingPhone, phoneCodeHash } = pending

    if (!client.connected) {
      logAuthEvent('verify_code_reconnect_client', { userId, correlationId })
      try { await client.connect() } catch { /* will fail at tgInvoke */ }
    }

    try {
      if (pending.awaitingPassword) {
        logAuthEvent('verify_code_password_step', { userId, correlationId })
        if (!password?.trim()) {
          throw new Error('Two-step verification password is required')
        }
        const tPwd = Date.now()
        await this.completePasswordStep(client, password.trim())
        logAuthEvent('verify_code_password_ok', { userId, correlationId, pwdTimeMs: Date.now() - tPwd })
      } else if (password?.trim()) {
        try {
          logAuthEvent('verify_code_signin_with_password', { userId, correlationId })
          await this.invokeTelegram(client, new Api.auth.SignIn({
            phoneNumber: pendingPhone,
            phoneCodeHash,
            phoneCode: normalizedCode,
          }))
        } catch (signInErr: unknown) {
          const msg = signInErr instanceof Error ? signInErr.message : String(signInErr)
          logAuthEvent('verify_code_signin_result', { userId, correlationId, error: msg })
          if (!msg.includes('SESSION_PASSWORD_NEEDED')) throw signInErr
          await this.persistAwaitingPassword(userId, client, pending)
          const tPwd = Date.now()
          await this.completePasswordStep(client, password.trim())
          logAuthEvent('verify_code_password_completed', { userId, correlationId, pwdTimeMs: Date.now() - tPwd })
        }
      } else {
        try {
          logAuthEvent('verify_code_signin', { userId, correlationId })
          const tSign = Date.now()
          await this.invokeTelegram(client, new Api.auth.SignIn({
            phoneNumber: pendingPhone,
            phoneCodeHash,
            phoneCode: normalizedCode,
          }))
          logAuthEvent('verify_code_signin_ok', { userId, correlationId, signTimeMs: Date.now() - tSign })
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          if (msg.includes('SESSION_PASSWORD_NEEDED')) {
            logAuthEvent('verify_code_needs_2fa', { userId, correlationId })
            await this.persistAwaitingPassword(userId, client, pending)
            return { requires_password: true }
          }
          const errCat = isRecoverableTelegramAuthError(err) ? 'recoverable' : 'fatal'
          logAuthEvent('verify_code_signin_error', { userId, correlationId, error: msg, category: errCat })
          if (errCat === 'fatal') {
            logTelegramAuthFailure(this.supabase, userId, 'verify_code', msg)
          }
          throw err
        }
      }
    } catch (err) {
      // Wrong 2FA / transient errors: keep pending so the user can retry without send_code.
      if (isRecoverableTelegramAuthError(err) && !isPhoneCodeFatalAuthError(err)) {
        if (pending.awaitingPassword) {
          await this.persistAwaitingPassword(userId, client, pending).catch(() => {})
        }
        throw err
      }
      try { await client.disconnect() } catch { /* ignore */ }
      this.pending.delete(userId)
      await this.clearPendingRow(userId)
      throw err
    }

    return this.finalizeAuth(client, userId, pendingPhone, correlationId)
  }

  async startQrLogin(userId: string): Promise<{ qr_url: string; expires_at: string }> {
    const correlationId = authCorrelationId()
    logAuthEvent('qr_login_start', { userId, correlationId })
    void persistListenerEvent(this.supabase, {
      userId,
      eventType: 'telegram_link_attempt',
      detail: { action: 'start_qr' },
    })
    const existing = this.pending.get(userId)
    if (existing?.method === 'qr' && existing.status === 'waiting' && existing.latestQrUrl) {
      logAuthEvent('qr_login_reuse', { userId, correlationId })
      return {
        qr_url: existing.latestQrUrl,
        expires_at: new Date(existing.expiresAt).toISOString(),
      }
    }

    this.markAuthInFlight(userId)
    const tStart = Date.now()
    try {
      await this.disconnectPending(userId, 'start_qr_login')

      const placeholderExpires = new Date(Date.now() + PENDING_DB_TTL_MS).toISOString()
      const { error: holdErr } = await this.supabase.from('telegram_auth_pending').upsert(
        {
          user_id: userId,
          auth_method: 'qr',
          phone: null,
          phone_code_hash: null,
          expires_at: placeholderExpires,
          awaiting_password: false,
          auth_session_string: null,
          qr_expires_at: null,
        },
        { onConflict: 'user_id' },
      )
      if (holdErr) {
        logAuthEvent('qr_login_hold_failed', { userId, correlationId, error: holdErr.message })
        console.error('[authService] QR auth hold upsert failed:', holdErr.message)
        throw new Error('Could not start Telegram QR login. Try again in a minute.')
      }

      // Wrap prepareForAuth + connect in a hard timeout so a hung promise
      // does not leave authInFlight stuck forever.
      const qrResult = await withAuthOperationTimeout((async (): Promise<{ qr_url: string; expires_at: string }> => {
          await this.sessionManager.prepareForAuth(userId)

          const client = this.createTelegramClient('')
          logAuthEvent('qr_login_connecting', { userId, correlationId })
          await client.connect()
          logAuthEvent('qr_login_connected', { userId, correlationId, connectTimeMs: Date.now() - tStart })

          const pending: QrPending = {
            method: 'qr',
            client,
            latestQrUrl: '',
            expiresAt: 0,
            status: 'waiting',
            createdAt: Date.now(),
          }
          this.pending.set(userId, pending)
          void this.runQrLoginBackground(userId, pending, correlationId)

          const deadline = Date.now() + QR_FIRST_TOKEN_WAIT_MS
          while (!pending.latestQrUrl && Date.now() < deadline) {
            await sleep(100)
            if (pending.status === 'error') {
              logAuthEvent('qr_login_token_error', { userId, correlationId, error: pending.error })
              console.warn(`[authService] startQrLogin QR error during token wait user=${userId}: ${pending.error}`)
              throw new Error(pending.error ?? 'Failed to generate QR code')
            }
          }
          if (!pending.latestQrUrl) {
            logAuthEvent('qr_login_token_timeout', { userId, correlationId, waitMs: QR_FIRST_TOKEN_WAIT_MS })
            console.warn(`[authService] startQrLogin no QR token within ${QR_FIRST_TOKEN_WAIT_MS}ms user=${userId}`)
            try { await client.disconnect() } catch { /* ignore */ }
            this.pending.delete(userId)
            await this.clearPendingRow(userId)
            throw new Error('Failed to generate QR code')
          }

          logAuthEvent('qr_login_token_ready', { userId, correlationId, expiresAt: new Date(pending.expiresAt).toISOString(), totalTimeMs: Date.now() - tStart })
          await this.persistQrPendingRow(userId, client, pending)
          return {
            qr_url: pending.latestQrUrl,
            expires_at: new Date(pending.expiresAt).toISOString(),
          }
        })())
      return qrResult
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      if (errMsg === 'AUTH_OPERATION_TIMEOUT') {
        logAuthEvent('qr_login_timeout', { userId, correlationId, totalTimeMs: Date.now() - tStart })
        console.warn(`[authService] startQrLogin timed out for user ${userId} after ${Date.now() - tStart}ms`)
      }
      void persistListenerEvent(this.supabase, {
        userId,
        eventType: 'telegram_link_failed',
        detail: { step: 'qr', error: errMsg },
      })
      throw err
    } finally {
      this.clearAuthInFlight(userId)
    }
  }

  async getQrStatus(userId: string): Promise<QrStatusResponse> {
    const pending = await this.getOrRestoreQrPending(userId)
    if (!pending) {
      // finalizeAuth clears pending before the UI poll observes success — recover from session.
      const { data: sess } = await this.supabase
        .from('telegram_sessions')
        .select('id')
        .eq('user_id', userId)
        .eq('is_active', true)
        .maybeSingle()
      if (sess?.id) {
        logAuthEvent('qr_status_active_session', { userId, sessionId: sess.id })
        return qrStatusFromActiveSession(String(sess.id))
      }
      // startQrLogin upserts a placeholder before the in-memory pending exists; polls
      // during prepareForAuth / connect must not surface "QR login expired".
      if (this.isAuthInFlight(userId)) {
        logAuthEvent('qr_status_starting', { userId })
        return { status: 'waiting' }
      }
      const { data: row } = await this.supabase
        .from('telegram_auth_pending')
        .select('auth_method, expires_at')
        .eq('user_id', userId)
        .maybeSingle()
      if (
        row?.auth_method === 'qr'
        && row.expires_at
        && new Date(row.expires_at).getTime() > Date.now()
      ) {
        logAuthEvent('qr_status_placeholder', { userId })
        return { status: 'waiting' }
      }
      logAuthEvent('qr_status_no_pending', { userId })
      throw new Error('NO_PENDING_QR')
    }

    const status = buildQrStatusFromPending({
      status: pending.status,
      latestQrUrl: pending.latestQrUrl,
      expiresAt: pending.expiresAt,
      error: pending.error,
      result: pending.result,
    })
    logAuthEvent('qr_status', { userId, status: pending.status, error: pending.error ?? 'none', hasResult: !!pending.result })
    return status
  }

  async verifyQrPassword(userId: string, password: string): Promise<VerifyResult> {
    const correlationId = authCorrelationId()
    logAuthEvent('qr_password_start', { userId, correlationId })
    const pending = await this.getOrRestoreQrPending(userId)
    if (!pending) {
      logAuthEvent('qr_password_no_pending', { userId, correlationId })
      throw new Error('NO_PENDING_QR')
    }
    if (pending.status !== 'requires_password') {
      logAuthEvent('qr_password_wrong_status', { userId, correlationId, status: pending.status })
      throw new Error('QR not awaiting password')
    }
    if (!password?.trim()) {
      throw new Error('Two-step verification password is required')
    }

    const tStart = Date.now()
    const resolver = this.qrPasswordResolvers.get(userId)
    if (resolver) {
      logAuthEvent('qr_password_resolver', { userId, correlationId })
      resolver.resolve(password.trim())
      this.qrPasswordResolvers.delete(userId)
    } else {
      logAuthEvent('qr_password_direct', { userId, correlationId })
      await this.completePasswordStep(pending.client, password.trim())
      const me = await pending.client.getMe()
      const phone = me.phone ? normalizePhoneNumber(`+${me.phone}`) : pending.phone ?? ''
      pending.status = 'success'
      pending.result = await this.finalizeAuth(pending.client, userId, phone || `tg:${me.id}`, correlationId, 'qr')
      return pending.result
    }

    const deadline = Date.now() + QR_PASSWORD_WAIT_MS
    while (Date.now() < deadline) {
      const current = this.pending.get(userId)
      if (current?.method === 'qr' && current.status === 'success' && current.result) {
        logAuthEvent('qr_password_success', { userId, correlationId, waitMs: Date.now() - tStart })
        return current.result
      }
      if (current?.method === 'qr' && current.status === 'error') {
        throw new Error(current.error ?? 'QR login failed')
      }
      // finalizeAuth temporarily removes the Map entry — keep waiting (and fall back to
      // an active session) instead of treating that gap as a timeout/failure.
      if (!current || current.method !== 'qr') {
        const { data: sess } = await this.supabase
          .from('telegram_sessions')
          .select('id')
          .eq('user_id', userId)
          .eq('is_active', true)
          .maybeSingle()
        if (sess?.id) {
          logAuthEvent('qr_password_success_via_session', {
            userId,
            correlationId,
            sessionId: sess.id,
            waitMs: Date.now() - tStart,
          })
          return { ok: true, session_id: String(sess.id) }
        }
        await sleep(200)
        continue
      }
      if (
        current.status === 'requires_password'
        || current.status === 'waiting'
        || current.status === 'success'
      ) {
        await sleep(200)
        continue
      }
      await sleep(200)
    }

    const { data: sess } = await this.supabase
      .from('telegram_sessions')
      .select('id')
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle()
    if (sess?.id) {
      logAuthEvent('qr_password_success_via_session_after_wait', {
        userId,
        correlationId,
        sessionId: sess.id,
      })
      return { ok: true, session_id: String(sess.id) }
    }
    throw new Error('QR login timed out')
  }
}

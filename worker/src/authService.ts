import { SupabaseClient } from '@supabase/supabase-js'
import { TelegramClient } from 'telegram'
import { Api } from 'telegram/tl'
import { computeCheck } from 'telegram/Password'
import { buildClient, tgInvoke, API_ID, API_HASH } from './telegramClient'
import { UserSessionManager } from './sessionManager'
import type { ChannelInfo } from './userListener'

interface PendingAuth {
  client: TelegramClient
  phone: string
  phoneCodeHash: string
  createdAt: number
  /** Code step succeeded; waiting for cloud password (do not call SignIn again). */
  awaitingPassword?: boolean
}

/**
 * Maximum age of a pending auth (between send_code and verify_code)
 * before we drop the in-memory client. Telegram codes expire in a few minutes;
 * DB-backed recovery lasts slightly longer for cross-replica / slow UX.
 */
const PENDING_TTL_MS = 10 * 60 * 1000
const CLEANUP_INTERVAL_MS = 60 * 1000
/** DB row outlives Telegram code validity slightly so retries still recover across replicas. */
const PENDING_DB_TTL_MS = 12 * 60 * 1000

function normalizePhoneNumber(raw: string): string {
  const compact = String(raw ?? '')
    .trim()
    .replace(/[\s\-()]/g, '')
  if (compact.startsWith('00')) return `+${compact.slice(2)}`
  return compact
}

function phonesMatch(a: string, b: string): boolean {
  return normalizePhoneNumber(a) === normalizePhoneNumber(b)
}

export type VerifyResult =
  | { ok: true; session_id: string; channels?: ChannelInfo[] }
  | { requires_password: true }

/**
 * Owns the MTProto connection during the send_code -> verify_code window.
 * The same TelegramClient is kept alive across both calls so we never re-auth
 * to a different DC. On success the live client is handed off to the
 * UserSessionManager and becomes the long-running listener client — there
 * is exactly one TCP connection per user from auth onward.
 */
export class AuthService {
  private pending = new Map<string, PendingAuth>()
  private cleanupTimer: NodeJS.Timeout

  constructor(
    private supabase: SupabaseClient,
    private sessionManager: UserSessionManager,
  ) {
    this.sessionManager.setAuthGuard(userId => this.pending.has(userId))
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS)
    if (typeof this.cleanupTimer.unref === 'function') this.cleanupTimer.unref()
  }

  shutdown() {
    clearInterval(this.cleanupTimer)
    for (const [, p] of this.pending) {
      p.client.disconnect().catch(() => {})
    }
    this.pending.clear()
  }

  private cleanup() {
    const now = Date.now()
    for (const [userId, p] of this.pending) {
      if (now - p.createdAt > PENDING_TTL_MS) {
        p.client.disconnect().catch(() => {})
        this.pending.delete(userId)
        console.log(`[authService] expired pending auth for user ${userId}`)
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

  private async clearPendingRow(userId: string) {
    await this.supabase.from('telegram_auth_pending').delete().eq('user_id', userId)
  }

  /**
   * When verify hits a different process than send_code, rebuild MTProto from the
   * persisted phone_code_hash (same approach as reconnecting after app restart).
   */
  private async restorePendingFromDatabase(userId: string, phone: string): Promise<PendingAuth | null> {
    const { data: row, error } = await this.supabase
      .from('telegram_auth_pending')
      .select('phone, phone_code_hash, expires_at, awaiting_password, auth_session_string')
      .eq('user_id', userId)
      .maybeSingle()

    if (error || !row) return null
    if (new Date(row.expires_at) < new Date()) {
      await this.clearPendingRow(userId)
      return null
    }
    if (!phonesMatch(row.phone, phone)) {
      console.warn(`[authService] verify phone mismatch for user ${userId}`)
      return null
    }

    const awaitingPassword = Boolean(row.awaiting_password)
    const savedSession =
      awaitingPassword && typeof row.auth_session_string === 'string' && row.auth_session_string.trim()
        ? row.auth_session_string.trim()
        : ''

    const client = buildClient(savedSession)
    await client.connect()
    return {
      client,
      phone: row.phone,
      phoneCodeHash: row.phone_code_hash,
      createdAt: Date.now(),
      awaitingPassword,
    }
  }

  private async persistAwaitingPassword(userId: string, client: TelegramClient): Promise<void> {
    const authSessionString = (client.session.save() as unknown) as string
    const { error } = await this.supabase
      .from('telegram_auth_pending')
      .update({
        awaiting_password: true,
        auth_session_string: authSessionString,
      })
      .eq('user_id', userId)
    if (error) {
      console.warn(`[authService] persistAwaitingPassword failed for ${userId}:`, error.message)
    }
  }

  private async completePasswordStep(client: TelegramClient, password: string): Promise<void> {
    const srpResult = await tgInvoke<Api.account.Password>(client, new Api.account.GetPassword())
    const srpCheck = await computeCheck(srpResult, password)
    await tgInvoke(client, new Api.auth.CheckPassword({ password: srpCheck }))
  }

  async sendCode(userId: string, phone: string): Promise<{ phone_code_hash: string }> {
    const normalizedPhone = normalizePhoneNumber(phone)
    if (!normalizedPhone || !normalizedPhone.startsWith('+')) {
      throw new Error('Use full phone with country code, e.g. +44...')
    }
    // Stop the live listener before touching telegram_auth_pending — clearing that row
    // triggers onAuthPendingCleared on other replicas, which must not reopen MTProto.
    await this.sessionManager.pauseForAuth(userId)

    const existing = this.pending.get(userId)
    if (existing) {
      try { await existing.client.disconnect() } catch { /* ignore */ }
      this.pending.delete(userId)
    }
    await this.clearPendingRow(userId)

    const client = buildClient('')
    await client.connect()

    try {
      const result = await tgInvoke<Api.auth.SentCode>(
        client,
        new Api.auth.SendCode({
          phoneNumber: normalizedPhone,
          apiId: API_ID,
          apiHash: API_HASH,
          settings: new Api.CodeSettings({
            allowFlashcall: false,
            currentNumber: true,
            allowAppHash: true,
          }),
        })
      )

      this.pending.set(userId, {
        client,
        phone: normalizedPhone,
        phoneCodeHash: result.phoneCodeHash,
        createdAt: Date.now(),
      })

      const expiresAt = new Date(Date.now() + PENDING_DB_TTL_MS).toISOString()
      const { error: dbErr } = await this.supabase.from('telegram_auth_pending').upsert(
        {
          user_id: userId,
          phone: normalizedPhone,
          phone_code_hash: result.phoneCodeHash,
          expires_at: expiresAt,
        },
        { onConflict: 'user_id' },
      )
      if (dbErr) {
        console.error('[authService] telegram_auth_pending upsert:', dbErr.message)
      }

      return { phone_code_hash: result.phoneCodeHash }
    } catch (err) {
      try { await client.disconnect() } catch { /* ignore */ }
      throw err
    }
  }

  async verifyCode(userId: string, phone: string, code: string, password?: string): Promise<VerifyResult> {
    const normalizedPhone = normalizePhoneNumber(phone)
    // Other replicas may still hold the listener until telegram_auth_pending realtime fires.
    await this.sessionManager.pauseForAuth(userId, { releaseDelay: false })

    let pending: PendingAuth | undefined = this.pending.get(userId)
    if (!pending) {
      const restored = await this.restorePendingFromDatabase(userId, normalizedPhone)
      if (restored) {
        pending = restored
        this.pending.set(userId, restored)
      }
    }
    if (!pending) {
      throw new Error('No pending auth flow. Call send_code first.')
    }

    const { client, phone: pendingPhone, phoneCodeHash } = pending

    try {
      if (pending.awaitingPassword) {
        if (!password?.trim()) {
          throw new Error('Two-step verification password is required')
        }
        await this.completePasswordStep(client, password.trim())
      } else if (password?.trim()) {
        // Legacy: password sent on first submit — try sign-in then 2FA if needed.
        try {
          await tgInvoke(client, new Api.auth.SignIn({
            phoneNumber: pendingPhone,
            phoneCodeHash,
            phoneCode: code,
          }))
        } catch (signInErr: unknown) {
          const msg = signInErr instanceof Error ? signInErr.message : String(signInErr)
          if (!msg.includes('SESSION_PASSWORD_NEEDED')) throw signInErr
          pending.awaitingPassword = true
          await this.persistAwaitingPassword(userId, client)
          await this.completePasswordStep(client, password.trim())
        }
      } else {
        try {
          await tgInvoke(client, new Api.auth.SignIn({
            phoneNumber: pendingPhone,
            phoneCodeHash,
            phoneCode: code,
          }))
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          if (msg.includes('SESSION_PASSWORD_NEEDED')) {
            pending.awaitingPassword = true
            await this.persistAwaitingPassword(userId, client)
            return { requires_password: true }
          }
          throw err
        }
      }
    } catch (err) {
      try { await client.disconnect() } catch { /* ignore */ }
      this.pending.delete(userId)
      await this.clearPendingRow(userId)
      throw err
    }

    const sessionString = (client.session.save() as unknown) as string

    const { data: row, error: dbErr } = await this.supabase
      .from('telegram_sessions')
      .upsert({
        user_id: userId,
        session_string: sessionString,
        phone_number: pendingPhone,
        is_active: true,
        listener_engine: 'gramjs',
      }, { onConflict: 'user_id' })
      .select('id')
      .single()

    if (dbErr || !row) {
      try { await client.disconnect() } catch { /* ignore */ }
      this.pending.delete(userId)
      await this.clearPendingRow(userId)
      throw new Error(dbErr?.message ?? 'Failed to persist Telegram session')
    }

    // Hand the *live* authenticated client to the session manager so it
    // becomes the long-running listener — no second connect from this host.
    this.pending.delete(userId)
    await this.clearPendingRow(userId)
    let channels: ChannelInfo[] | undefined
    try {
      await this.sessionManager.adoptClient(userId, client, sessionString)
      try {
        channels = await this.sessionManager.listChannelsForAdoptedUser(userId, { skipColdDelay: true })
      } catch (listErr) {
        console.warn(`[authService] listChannels after verify failed for ${userId}:`, listErr)
      }
    } catch (err) {
      console.error(`[authService] adoptClient failed for ${userId}:`, err)
      try {
        await client.disconnect()
      } catch {
        /* ignore */
      }
    }

    return { ok: true, session_id: row.id as string, channels }
  }
}

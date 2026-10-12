import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptMtPassword } from './brokerCredentialsCrypto'
import type { MtPlatform } from './fxsocketClient'
import { getMtapiProvider, MtapiApiError, type MtapiProvider } from './mtapiProvider'
import { authorityFromBrokerRow, withBrokerWriteAuthority } from './brokerWriteAuthority'
import { captureCriticalHealthIssue } from './observability/criticalHealth'
import { addWorkerBreadcrumb } from './observability/sentry'

type MtapiSessionRow = {
  id: string
  mtapi_session_id: string | null
  account_login: string | null
  broker_server: string | null
  platform: string | null
  broker_password_encrypted: string | null
  auto_reconnect_enabled: boolean | null
  connection_status: string | null
  performance_baseline_balance?: number | null
  provider?: string | null
  fxsocket_account_id?: string | null
  metaapi_account_id?: string | null
  writer_epoch?: number | null
  provider_transition_state?: 'stable' | 'transition' | null
}

function enabled(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === '') return fallback
  return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase())
}

function platformOf(value: string | null): MtPlatform {
  return String(value ?? '').toUpperCase() === 'MT4' ? 'MT4' : 'MT5'
}

function safeCode(error: unknown): string {
  if (error instanceof MtapiApiError) return error.code || ('HTTP_' + error.status)
  return error instanceof Error ? error.name : 'UNKNOWN'
}

/**
 * Plain-English text for the bridge error codes that reach an operator in the
 * log and a customer in `broker_accounts.connection_error`. The bridge sends
 * codes only, so a rejection such as `INVALID_ACCOUNT` would otherwise arrive
 * as a bare constant that says nothing about what to fix. Codes without an
 * entry keep their existing behaviour and are reported on their own.
 */
const MTAPI_CODE_DETAIL: Record<string, string> = {
  INVALID_ACCOUNT: 'invalid login or password',
  HTTP_502: 'broker bridge temporarily unavailable',
  HTTP_503: 'broker bridge temporarily unavailable',
  HTTP_504: 'broker bridge temporarily unavailable',
  TRANSPORT_ERROR: 'broker bridge unreachable',
}

/**
 * Codes that mean "the bridge could not answer right now", not "this account
 * can never connect". A temporary failure must be retried rather than marking
 * the account as `error`: during the 2026-10-08 bridge outage a single 502 was
 * written as a permanent error and stranded customers until it was reset by
 * hand. Anything else (for example INVALID_ACCOUNT) is a real rejection and is
 * surfaced immediately.
 */
const TRANSIENT_PROVISION_CODES = new Set([
  'TRANSPORT_ERROR',
  'INVALID_RESPONSE',
  'HTTP_429',
  'RATE_LIMITED',
  'TIMEOUT',
])

export function isTransientProvisionError(code: string): boolean {
  return TRANSIENT_PROVISION_CODES.has(code) || /^HTTP_5\d\d$/.test(code)
}

export function mtapiFailureDetail(code: string): string {
  // hasOwnProperty, not a plain lookup: `code` comes from the bridge response,
  // so a value like "toString" must not resolve to an Object.prototype member
  // and end up in a customer-visible column.
  return Object.prototype.hasOwnProperty.call(MTAPI_CODE_DETAIL, code)
    ? MTAPI_CODE_DETAIL[code]
    : ''
}

/**
 * Customer-facing text for `connection_error`. Plain English only: the raw
 * bridge code must not reach the user. Support still gets it — the worker log
 * records `code=... detail=...` on the same failure.
 */
export function mtapiFailureSummary(code: string): string {
  const detail = mtapiFailureDetail(code)
  return detail || code
}

function mtapiConfigured(): boolean {
  return Boolean(
    String(process.env.MTAPI_BASE_URL ?? '').trim()
    || String(process.env.MTAPI_MT4_BASE_URL ?? '').trim()
    || String(process.env.MTAPI_MT5_BASE_URL ?? '').trim(),
  )
}

/**
 * Parse an interval env value. Empty, malformed, or absurd text falls back to
 * the default — a typo like "15000ms" must not become a 1 ms hot loop, a
 * blank value must not clamp to the floor, and a value above 2^31-1 would be
 * silently turned into 1 ms by Node's setTimeout — and a finite value is
 * clamped at the floor.
 */
const MAX_INTERVAL_MS = 2_147_483_647
export function resolveIntervalMs(raw: string | undefined, fallback: number, floor: number): number {
  const text = (raw ?? '').trim()
  if (text === '') return fallback
  const ms = Number(text)
  return Number.isFinite(ms) && ms <= MAX_INTERVAL_MS ? Math.max(floor, ms) : fallback
}

export class MtapiSessionManager {
  private timer: NodeJS.Timeout | null = null
  private provisionTimer: NodeJS.Timeout | null = null
  private sweepRunning = false
  private provisionRunning = false
  /** Earliest epoch ms at which the next paced sweep request may start. */
  private nextSweepStartAt = 0
  /** Wait before trying a temporary bridge failure again, per account. */
  private readonly provisionRetries = new Map<string, { attempts: number; nextAttemptAt: number }>()
  /** Start of the current run of bridge-level (5xx/transport) failures. */
  private bridgeOutageStartedAt: number | null = null
  private bridgeOutageAlertSent = false

  constructor(
    private readonly supabase: SupabaseClient,
    private readonly provider: MtapiProvider = getMtapiProvider(),
  ) {}

  private provisionRetryBaseMs(): number {
    return resolveIntervalMs(process.env.MTAPI_PROVISION_RETRY_BASE_MS, 15_000, 1_000)
  }

  private provisionRetryMaxMs(): number {
    return resolveIntervalMs(process.env.MTAPI_PROVISION_RETRY_MAX_MS, 300_000, 1_000)
  }

  private bridgeOutageGraceMs(): number {
    return resolveIntervalMs(process.env.MTAPI_BRIDGE_OUTAGE_GRACE_MS, 120_000, 5_000)
  }

  /** Epoch ms before which this account must not be tried again. */
  private nextProvisionAttemptAt(id: string): number {
    return this.provisionRetries.get(id)?.nextAttemptAt ?? 0
  }

  private scheduleProvisionRetry(id: string): void {
    const state = this.provisionRetries.get(id) ?? { attempts: 0, nextAttemptAt: 0 }
    state.attempts += 1
    const delay = Math.min(
      this.provisionRetryMaxMs(),
      this.provisionRetryBaseMs() * 2 ** (state.attempts - 1),
    )
    state.nextAttemptAt = Date.now() + delay
    this.provisionRetries.set(id, state)
  }

  /**
   * Record a bridge-level failure. After a sustained run (default 2 minutes)
   * raise exactly one Sentry critical-health issue, so a total bridge outage
   * alerts instead of running silently for hours. Repeated calls are cheap and
   * controlled by `bridgeOutageAlertSent`, and the critical-health layer
   * suppresses repeats of its own as well.
   */
  private noteBridgeFailure(): void {
    const now = Date.now()
    if (this.bridgeOutageStartedAt == null) this.bridgeOutageStartedAt = now
    if (this.bridgeOutageAlertSent) return
    if (now - this.bridgeOutageStartedAt < this.bridgeOutageGraceMs()) return
    this.bridgeOutageAlertSent = true
    captureCriticalHealthIssue({
      component: 'broker_rpc',
      failureClass: 'sustained_outage',
      provider: 'mtapi',
      state: 'unavailable',
      severity: 'critical',
      reasonCode: 'MTAPI_BRIDGE_UNAVAILABLE',
      message: 'mtapi_bridge_unavailable',
      fingerprint: ['critical_health', 'broker_rpc', 'mtapi', 'bridge_unavailable'],
      dedupeKey: 'critical_health|broker_rpc|mtapi|bridge_unavailable',
      metadata: { duration_ms: now - this.bridgeOutageStartedAt },
    })
  }

  private noteBridgeSuccess(): void {
    if (this.bridgeOutageStartedAt != null && this.bridgeOutageAlertSent) {
      addWorkerBreadcrumb({
        category: 'worker',
        level: 'info',
        message: 'MTAPI bridge recovered',
        data: { duration_ms: Math.max(0, Date.now() - this.bridgeOutageStartedAt) },
      })
    }
    this.bridgeOutageStartedAt = null
    this.bridgeOutageAlertSent = false
  }

  private async sessions(): Promise<MtapiSessionRow[]> {
    const { data, error } = await this.supabase
      .from('broker_accounts')
      .select('id,provider,mtapi_session_id,fxsocket_account_id,metaapi_account_id,writer_epoch,provider_transition_state,account_login,broker_server,platform,broker_password_encrypted,auto_reconnect_enabled,performance_baseline_balance')
      .eq('provider', 'mtapi')
    if (error) throw new Error('MTAPI session query failed')
    return (data ?? []) as MtapiSessionRow[]
  }

  private async recoverWithCredentials(sessionId: string): Promise<string | null> {
    const { data, error } = await this.supabase
      .from('broker_accounts')
      .select('id,provider,mtapi_session_id,fxsocket_account_id,metaapi_account_id,writer_epoch,provider_transition_state,account_login,broker_server,platform,broker_password_encrypted,auto_reconnect_enabled,performance_baseline_balance')
      .eq('provider', 'mtapi')
      .eq('mtapi_session_id', sessionId)
      .maybeSingle()
    if (error || !data) return null
    const row = data as MtapiSessionRow
    if (row.auto_reconnect_enabled !== true) return null
    const password = decryptMtPassword(row.broker_password_encrypted)
    const login = String(row.account_login ?? '').trim()
    const server = String(row.broker_server ?? '').trim()
    if (!password || !login || !server) return null

    return withBrokerWriteAuthority(
      authorityFromBrokerRow(row),
      'mtapi_reconnect',
      async () => {
        const token = await this.provider.connectEx({
          id: sessionId,
          server,
          login,
          password,
          platform: platformOf(row.platform),
        })
        if (token !== sessionId) {
          const { data: updated, error: updateError } = await this.supabase
            .from('broker_accounts')
            .update({
              mtapi_session_id: token,
              connection_status: 'connected',
              mtapi_status: 'connected',
            })
            .eq('id', row.id)
            .eq('provider', 'mtapi')
            .eq('provider_transition_state', 'stable')
            .eq('writer_epoch', row.writer_epoch)
            .eq('mtapi_session_id', sessionId)
            .select('id')
            .maybeSingle()
          if (updateError || !updated) {
            await this.provider.disconnect(token).catch(() => undefined)
            throw new Error('MTAPI recovered token persistence failed')
          }
        }
        return token
      },
    )
  }

  private async reconcileOrphans(rows: MtapiSessionRow[]): Promise<void> {
    if (!enabled(process.env.MTAPI_DISCONNECT_ORPHANS_ENABLED, true)) return
    const mt4Url = String(process.env.MTAPI_MT4_BASE_URL ?? '').trim().replace(/\/+$/, '')
    const { data: allSessionRows, error: allSessionError } = await this.supabase
      .from('broker_accounts')
      .select('id,mtapi_session_id,platform')
      .not('mtapi_session_id', 'is', null)
    const knownRows = allSessionError
      ? rows
      : (allSessionRows ?? []) as MtapiSessionRow[]

    const mt5Url = String(process.env.MTAPI_MT5_BASE_URL ?? '').trim().replace(/\/+$/, '')
    const separateBridges = Boolean(mt4Url && mt5Url && mt4Url !== mt5Url)
    const groups: Array<{ platform: MtPlatform; ids: string[] }> = separateBridges
      ? (['MT4', 'MT5'] as const).map(platform => ({
        platform,
        ids: knownRows
          .filter(row => platformOf(row.platform) === platform)
          .map(row => String(row.mtapi_session_id ?? '').trim())
          .filter(Boolean),
      }))
      : [{
        platform: 'MT5',
        ids: knownRows.map(row => String(row.mtapi_session_id ?? '').trim()).filter(Boolean),
      }]
    for (const { platform, ids } of groups) {
      if (platform === 'MT4') {
        console.warn('[mtapiSession] orphan reconciliation skipped platform=MT4 endpoint unavailable')
        continue
      }
      try {
        await this.provider.disconnectOrphans(ids, true, platform)
        await this.provider.disconnectOrphans(ids, false, platform)
      } catch (error) {
        console.warn('[mtapiSession] orphan reconciliation failed platform=' + platform + ' code=' + safeCode(error))
      }
    }
  }

  private async syncAccountState(row: MtapiSessionRow, sessionId: string): Promise<void> {
    const summary = await this.provider.accountSummary(sessionId)
    const now = new Date().toISOString()
    const patch: Record<string, unknown> = {
      mtapi_status: 'connected',
      connection_status: 'connected',
      connection_error: null,
      last_synced_at: now,
    }
    if (summary.balance != null) patch.last_balance = summary.balance
    if (summary.equity != null) patch.last_equity = summary.equity
    if (summary.currency != null) patch.last_currency = summary.currency
    if (summary.type != null) {
      patch.linked_account_type = summary.type === 0 || summary.type === 1 ? 'Demo' : 'Live'
    }
    if (row.performance_baseline_balance == null && summary.balance != null) {
      patch.performance_baseline_balance = summary.balance
      patch.performance_baseline_captured_at = now
    }
    const { error } = await this.supabase
      .from('broker_accounts')
      .update(patch)
      .eq('id', row.id)
      .eq('provider', 'mtapi')
      .eq('provider_transition_state', 'stable')
      .eq('writer_epoch', row.writer_epoch)
      .eq('mtapi_session_id', sessionId)
    if (error) throw new Error('MTAPI account state persist failed')
  }

  /**
   * Space out the start of health-check requests so the whole fleet cannot hit
   * the bridge at once. The bridge rejects bursts over ~10 req/s per source IP
   * with `429 rate_limited`, and a simultaneous sweep over every session was
   * exactly that burst — it starved real orders (see the 2026-10-05 incident).
   * Requests are paced per process and jittered so they do not re-synchronise
   * with other periodic traffic.
   */
  private async paceSweepStart(gapMs: number): Promise<void> {
    if (gapMs <= 0) return
    const jitter = gapMs * (0.5 + Math.random())
    const now = Date.now()
    const startAt = Math.max(now, this.nextSweepStartAt)
    this.nextSweepStartAt = startAt + jitter
    const wait = startAt - now
    if (wait > 0) await new Promise<void>(resolve => setTimeout(resolve, wait))
  }

  private async sweepOne(row: MtapiSessionRow): Promise<void> {
    const sessionId = String(row.mtapi_session_id ?? '').trim()
    if (!sessionId) return
    this.provider.seedPlatformCache(sessionId, platformOf(row.platform))
    try {
      await this.provider.ensureConnected(sessionId)
      await this.syncAccountState(row, sessionId)
      this.noteBridgeSuccess()
    } catch (error) {
      const code = safeCode(error)
      if (isTransientProvisionError(code)) this.noteBridgeFailure()
      const detail = mtapiFailureDetail(code)
      console.warn('[mtapiSession] health recovery failed broker=' + row.id + ' code=' + code
        + (detail ? ' detail=' + detail : ''))
    }
  }

  private async sweep(rows?: MtapiSessionRow[]): Promise<void> {
    if (this.sweepRunning) return
    this.sweepRunning = true
    try {
      const current = rows ?? await this.sessions()
      // A handful of workers hide per-session latency, while the per-process
      // pacer bounds the number of session starts. Note: each session start
      // makes ~2 bridge calls (CheckConnect + AccountSummary), and every
      // replica sweeps all sessions, so aggregate request rate is roughly
      // replicas x 2 / gap. The nginx zone exemption is the real safety net;
      // this pacing just removes the self-inflicted burst.
      const concurrency = Math.min(8, resolveIntervalMs(process.env.MTAPI_SESSION_HEALTH_CONCURRENCY, 2, 1))
      const gapMs = resolveIntervalMs(process.env.MTAPI_SESSION_HEALTH_GAP_MS, 250, 0)
      let index = 0
      const worker = async (): Promise<void> => {
        for (;;) {
          const i = index++
          if (i >= current.length) return
          await this.paceSweepStart(gapMs)
          await this.sweepOne(current[i])
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(concurrency, current.length) }, () => worker()),
      )
    } finally {
      this.sweepRunning = false
    }
  }

  private async provisionNewAccounts(): Promise<void> {
    // The provision timer (15 s) is shorter than one bridge call can take
    // (HTTP timeout 20 s). Without this guard a slow ConnectEx would let a
    // second scan claim the same pending row and open a second bridge session
    // for one login, leaking an orphan the reconciler cannot see.
    if (this.provisionRunning) return
    this.provisionRunning = true
    try {
      await this.provisionPendingAccounts()
    } finally {
      this.provisionRunning = false
    }
  }

  private async provisionPendingAccounts(): Promise<void> {
    const { data, error } = await this.supabase
      .from('broker_accounts')
      .select('id,provider,mtapi_session_id,fxsocket_account_id,metaapi_account_id,writer_epoch,provider_transition_state,account_login,broker_server,platform,broker_password_encrypted,performance_baseline_balance')
      .eq('provider', 'mtapi')
      .eq('provider_transition_state', 'stable')
      .is('mtapi_session_id', null)
      .eq('connection_status', 'pending')
    if (error) {
      console.warn('[mtapiSession] provision query failed code=' + error.message)
      return
    }
    const pending = (data ?? []) as MtapiSessionRow[]
    // Log only real work: at the 15 s cadence a "pending=0" line every tick
    // would be thousands of lines a day.
    if (pending.length > 0) {
      console.info('[mtapiSession] provision scan pending=' + pending.length)
    }
    for (const row of pending) {
      // A temporary bridge failure keeps the row `pending` and schedules a
      // retry; skip it until that wait has passed.
      if (this.nextProvisionAttemptAt(row.id) > Date.now()) continue
      const password = decryptMtPassword(row.broker_password_encrypted)
      const login = String(row.account_login ?? '').trim()
      const server = String(row.broker_server ?? '').trim()
      if (!password || !login || !server) {
        console.warn('[mtapiSession] provision skipped broker=' + row.id + ' (missing credentials)')
        continue
      }
      try {
        const token = await this.provider.connectEx({
          id: '',
          server,
          login,
          password,
          platform: platformOf(row.platform),
        })
        this.provisionRetries.delete(row.id)
        this.noteBridgeSuccess()
        const { data: updated, error: updErr } = await this.supabase
          .from('broker_accounts')
          .update({ mtapi_session_id: token, connection_status: 'connected', mtapi_status: 'connected', connection_error: null })
          .eq('id', row.id)
          .eq('provider', 'mtapi')
          .eq('provider_transition_state', 'stable')
          .eq('writer_epoch', row.writer_epoch)
          .is('mtapi_session_id', null)
          .eq('connection_status', 'pending')
          .select('id')
          .maybeSingle()
        if (updErr || !updated) {
          await this.provider.disconnect(token).catch(() => undefined)
          console.warn(
            '[mtapiSession] provision persist failed broker=' + row.id
            + ' code=' + (updErr?.message ?? 'STALE_AUTHORITY'),
          )
          continue
        }
        this.provider.seedPlatformCache(token, platformOf(row.platform))
        console.info('[mtapiSession] provisioned broker=' + row.id)
        try {
          await this.syncAccountState({ ...row, connection_status: 'connected' }, token)
        } catch (syncError) {
          console.warn('[mtapiSession] initial account sync failed broker=' + row.id + ' code=' + safeCode(syncError))
        }
      } catch (err) {
        const code = safeCode(err)
        const detail = mtapiFailureDetail(code)
        if (isTransientProvisionError(code)) {
          this.noteBridgeFailure()
          this.scheduleProvisionRetry(row.id)
          // Leave the row `pending` so it recovers on its own, but tell the
          // customer why it is taking time. Writing `connection_status='error'`
          // is what stranded accounts during the 2026-10-08 outage, so only the
          // message is written here; the status guard keeps a concurrent
          // successful connect from being overwritten.
          await this.supabase
            .from('broker_accounts')
            .update({ connection_error: 'MTAPI connect failed: ' + mtapiFailureSummary(code) })
            .eq('id', row.id)
            .eq('provider', 'mtapi')
            .eq('connection_status', 'pending')
          console.warn('[mtapiSession] provision retry scheduled broker=' + row.id
            + ' code=' + code + (detail ? ' detail=' + detail : '')
            + ' attempt=' + (this.provisionRetries.get(row.id)?.attempts ?? 0)
            + ' in_ms=' + Math.max(0, this.nextProvisionAttemptAt(row.id) - Date.now()))
          continue
        }
        this.provisionRetries.delete(row.id)
        console.warn('[mtapiSession] provision failed broker=' + row.id + ' code=' + code
          + (detail ? ' detail=' + detail : ''))
        await this.supabase
          .from('broker_accounts')
          .update({
            connection_status: 'error',
            mtapi_status: 'error',
            connection_error: 'MTAPI connect failed: ' + mtapiFailureSummary(code),
          })
          .eq('id', row.id)
          .eq('connection_status', 'pending')
      }
    }
  }

  async start(): Promise<void> {
    if (!mtapiConfigured()) return
    this.provider.setRecoveryHandler(id => this.recoverWithCredentials(id))
    const rows = await this.sessions()
    for (const row of rows) {
      const id = String(row.mtapi_session_id ?? '').trim()
      if (id) this.provider.seedPlatformCache(id, platformOf(row.platform))
    }
    await this.reconcileOrphans(rows)
    await this.provisionNewAccounts()
    // Do NOT await the initial health sweep. It is now paced (~1 session per
    // gap) so awaiting it would delay the trade executor by tens of seconds on
    // every restart. The interval timer re-runs it anyway; sessions are already
    // seeded above, and a session found unhealthy is recovered by the trade
    // path on first use.
    void this.sweep(rows).catch(error => {
      console.warn('[mtapiSession] initial health sweep failed code=' + safeCode(error))
    })
    // A newly authorised account waits for the provision sweep, so it runs far
    // more often than the health sweep: the bridge link must be made in
    // seconds, not minutes. The health sweep stays slow because it queries the
    // bridge once per session.
    const provisionIntervalMs = resolveIntervalMs(process.env.MTAPI_PROVISION_INTERVAL_MS, 15_000, 5_000)
    this.provisionTimer = setInterval(() => {
      void this.provisionNewAccounts().catch(error => {
        console.warn('[mtapiSession] provision sweep failed code=' + safeCode(error))
      })
    }, provisionIntervalMs)
    this.provisionTimer.unref?.()
    const intervalMs = resolveIntervalMs(process.env.MTAPI_SESSION_HEALTH_INTERVAL_MS, 240_000, 30_000)
    this.timer = setInterval(() => {
      void this.sweep().catch(error => {
        console.warn('[mtapiSession] health sweep failed code=' + safeCode(error))
      })
    }, intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.provisionTimer) clearInterval(this.provisionTimer)
    this.provisionTimer = null
    this.provider.setRecoveryHandler(undefined)
  }
}

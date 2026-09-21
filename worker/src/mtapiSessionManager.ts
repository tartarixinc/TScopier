import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptMtPassword } from './brokerCredentialsCrypto'
import type { MtPlatform } from './fxsocketClient'
import { getMtapiProvider, MtapiApiError, type MtapiProvider } from './mtapiProvider'

type MtapiSessionRow = {
  id: string
  mtapi_session_id: string | null
  account_login: string | null
  broker_server: string | null
  platform: string | null
  broker_password_encrypted: string | null
  auto_reconnect_enabled: boolean | null
  connection_status: string | null
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

function mtapiConfigured(): boolean {
  return Boolean(
    String(process.env.MTAPI_BASE_URL ?? '').trim()
    || String(process.env.MTAPI_MT4_BASE_URL ?? '').trim()
    || String(process.env.MTAPI_MT5_BASE_URL ?? '').trim(),
  )
}

export class MtapiSessionManager {
  private timer: NodeJS.Timeout | null = null
  private sweepRunning = false

  constructor(
    private readonly supabase: SupabaseClient,
    private readonly provider: MtapiProvider = getMtapiProvider(),
  ) {}

  private async sessions(): Promise<MtapiSessionRow[]> {
    const { data, error } = await this.supabase
      .from('broker_accounts')
      .select('id,mtapi_session_id,account_login,broker_server,platform,broker_password_encrypted,auto_reconnect_enabled')
      .eq('provider', 'mtapi')
    if (error) throw new Error('MTAPI session query failed')
    return (data ?? []) as MtapiSessionRow[]
  }

  private async recoverWithCredentials(sessionId: string): Promise<string | null> {
    const { data, error } = await this.supabase
      .from('broker_accounts')
      .select('id,mtapi_session_id,account_login,broker_server,platform,broker_password_encrypted,auto_reconnect_enabled')
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

    const token = await this.provider.connectEx({
      id: sessionId,
      server,
      login,
      password,
      platform: platformOf(row.platform),
    })
    if (token !== sessionId) {
      const { error: updateError } = await this.supabase
        .from('broker_accounts')
        .update({ mtapi_session_id: token, connection_status: 'connected' })
        .eq('id', row.id)
        .eq('mtapi_session_id', sessionId)
      if (updateError) throw new Error('MTAPI recovered token persistence failed')
    }
    return token
  }

  private async reconcileOrphans(rows: MtapiSessionRow[]): Promise<void> {
    if (!enabled(process.env.MTAPI_DISCONNECT_ORPHANS_ENABLED, true)) return
    const mt4Url = String(process.env.MTAPI_MT4_BASE_URL ?? '').trim().replace(/\/+$/, '')
    const mt5Url = String(process.env.MTAPI_MT5_BASE_URL ?? '').trim().replace(/\/+$/, '')
    const separateBridges = Boolean(mt4Url && mt5Url && mt4Url !== mt5Url)
    const groups: Array<{ platform: MtPlatform; ids: string[] }> = separateBridges
      ? (['MT4', 'MT5'] as const).map(platform => ({
        platform,
        ids: rows
          .filter(row => platformOf(row.platform) === platform)
          .map(row => String(row.mtapi_session_id ?? '').trim())
          .filter(Boolean),
      }))
      : [{
        platform: 'MT5',
        ids: rows.map(row => String(row.mtapi_session_id ?? '').trim()).filter(Boolean),
      }]
    for (const { platform, ids } of groups) {
      try {
        await this.provider.disconnectOrphans(ids, true, platform)
        await this.provider.disconnectOrphans(ids, false, platform)
      } catch (error) {
        console.warn('[mtapiSession] orphan reconciliation failed platform=' + platform + ' code=' + safeCode(error))
      }
    }
  }

  private async sweep(rows?: MtapiSessionRow[]): Promise<void> {
    if (this.sweepRunning) return
    this.sweepRunning = true
    try {
      const current = rows ?? await this.sessions()
      await Promise.all(current.map(async row => {
        const sessionId = String(row.mtapi_session_id ?? '').trim()
        if (!sessionId) return
        this.provider.seedPlatformCache(sessionId, platformOf(row.platform))
        try {
          await this.provider.ensureConnected(sessionId)
        } catch (error) {
          console.warn('[mtapiSession] health recovery failed broker=' + row.id + ' code=' + safeCode(error))
        }
      }))
    } finally {
      this.sweepRunning = false
    }
  }

  private async provisionNewAccounts(): Promise<void> {
    const { data, error } = await this.supabase
      .from('broker_accounts')
      .select('id,account_login,broker_server,platform,broker_password_encrypted')
      .eq('provider', 'mtapi')
      .is('mtapi_session_id', null)
      .eq('connection_status', 'pending')
    if (error) {
      console.warn('[mtapiSession] provision query failed code=' + error.message)
      return
    }
    const pending = (data ?? []) as MtapiSessionRow[]
    for (const row of pending) {
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
        const { error: updErr } = await this.supabase
          .from('broker_accounts')
          .update({ mtapi_session_id: token, connection_status: 'connected', connection_error: null })
          .eq('id', row.id)
          .eq('connection_status', 'pending')
        if (updErr) {
          console.warn('[mtapiSession] provision persist failed broker=' + row.id + ' code=' + updErr.message)
          continue
        }
        this.provider.seedPlatformCache(token, platformOf(row.platform))
        console.info('[mtapiSession] provisioned broker=' + row.id + ' token=' + token.slice(0, 8) + '...')
      } catch (err) {
        const code = safeCode(err)
        console.warn('[mtapiSession] provision failed broker=' + row.id + ' code=' + code)
        await this.supabase
          .from('broker_accounts')
          .update({ connection_status: 'error', connection_error: 'MTAPI connect failed: ' + code })
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
    await this.sweep(rows)
    const intervalMs = Math.max(30_000, Number(process.env.MTAPI_SESSION_HEALTH_INTERVAL_MS ?? 240_000))
    this.timer = setInterval(() => {
      void Promise.all([
        this.provisionNewAccounts().catch(error => {
          console.warn('[mtapiSession] provision sweep failed code=' + safeCode(error))
        }),
        this.sweep().catch(error => {
          console.warn('[mtapiSession] health sweep failed code=' + safeCode(error))
        }),
      ])
    }, intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.provider.setRecoveryHandler(undefined)
  }
}

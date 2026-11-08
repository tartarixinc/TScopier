import type { SupabaseClient } from '@supabase/supabase-js'
import { MtapiWsClient, type MtapiWsClientOptions } from './mtapiWsClient'
import { parseEnvBool } from './workerConfig'

export type MtapiOrderUpdateSource = {
  brokerAccountId: string
  sessionId: string
  platform: string | null
}

export type MtapiOrderUpdateHubOptions = {
  supabase: SupabaseClient
  onSourceUpdate: (brokerAccountId: string) => void
  refreshIntervalMs?: number
  debounceMs?: number
  enabled?: boolean
  createClient?: (opts: MtapiWsClientOptions) => MtapiWsClient
}

type SessionEntry = {
  sessionId: string
  platform: string | null
  brokerAccountIds: Set<string>
  client: MtapiWsClient
  debounceTimer: NodeJS.Timeout | null
  pendingBrokerIds: Set<string>
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export function mtapiOrderUpdateWsEnabled(defaultValue = false): boolean {
  return parseEnvBool(process.env.MTAPI_ORDER_UPDATE_WS_ENABLED, defaultValue)
}

/**
 * Maintains one OnOrderUpdate WebSocket per active MTAPI copy source session and
 * debounces wakes into social/mirror monitors.
 */
export class MtapiOrderUpdateHub {
  private readonly supabase: SupabaseClient
  private readonly onSourceUpdate: (brokerAccountId: string) => void
  private readonly refreshIntervalMs: number
  private readonly debounceMs: number
  private readonly createClient: (opts: MtapiWsClientOptions) => MtapiWsClient
  private readonly sessions = new Map<string, SessionEntry>()
  private refreshTimer: NodeJS.Timeout | null = null
  private refreshing = false
  private started = false
  private stopped = false

  constructor(options: MtapiOrderUpdateHubOptions) {
    this.supabase = options.supabase
    this.onSourceUpdate = options.onSourceUpdate
    this.refreshIntervalMs = Math.max(
      5_000,
      options.refreshIntervalMs ?? envNumber('MTAPI_ORDER_UPDATE_WS_REFRESH_MS', 30_000),
    )
    this.debounceMs = Math.max(
      50,
      options.debounceMs ?? envNumber('MTAPI_ORDER_UPDATE_WS_DEBOUNCE_MS', 150),
    )
    this.createClient = options.createClient ?? ((opts) => new MtapiWsClient(opts))
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.stopped = false
    void this.refresh()
    this.refreshTimer = setInterval(() => void this.refresh(), this.refreshIntervalMs)
    this.refreshTimer.unref?.()
  }

  stop(): void {
    this.stopped = true
    this.started = false
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
    for (const entry of this.sessions.values()) {
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
      entry.client.close()
    }
    this.sessions.clear()
  }

  /** Test/ops helper: currently tracked session count. */
  get sessionCount(): number {
    return this.sessions.size
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return
    this.refreshing = true
    try {
      if (this.stopped) {
        for (const entry of this.sessions.values()) {
          if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
          entry.client.close()
        }
        this.sessions.clear()
        return
      }
      const sources = await this.loadActiveSources()
      const nextBySession = new Map<string, MtapiOrderUpdateSource[]>()
      for (const source of sources) {
        const list = nextBySession.get(source.sessionId) ?? []
        list.push(source)
        nextBySession.set(source.sessionId, list)
      }

      for (const [sessionId, entry] of [...this.sessions.entries()]) {
        if (!nextBySession.has(sessionId)) {
          if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
          entry.client.close()
          this.sessions.delete(sessionId)
        }
      }

      for (const [sessionId, sourceList] of nextBySession.entries()) {
        const brokerIds = new Set(sourceList.map(row => row.brokerAccountId))
        const platform = sourceList[0]?.platform ?? null
        const existing = this.sessions.get(sessionId)
        if (existing) {
          existing.brokerAccountIds = brokerIds
          existing.platform = platform
          continue
        }
        const entry: SessionEntry = {
          sessionId,
          platform,
          brokerAccountIds: brokerIds,
          client: this.createClient({ sessionId, platform }),
          debounceTimer: null,
          pendingBrokerIds: new Set(),
        }
        entry.client.onMessage((event) => {
          if (!event.copyRelevant) return
          for (const brokerAccountId of entry.brokerAccountIds) {
            entry.pendingBrokerIds.add(brokerAccountId)
          }
          if (entry.debounceTimer) return
          entry.debounceTimer = setTimeout(() => {
            entry.debounceTimer = null
            const ids = [...entry.pendingBrokerIds]
            entry.pendingBrokerIds.clear()
            for (const brokerAccountId of ids) {
              try {
                this.onSourceUpdate(brokerAccountId)
              } catch (error) {
                console.warn(
                  '[mtapi-order-update] poke failed:',
                  error instanceof Error ? error.message : String(error),
                )
              }
            }
          }, this.debounceMs)
        })
        this.sessions.set(sessionId, entry)
        entry.client.connect()
      }
    } catch (error) {
      console.warn(
        '[mtapi-order-update] refresh failed:',
        error instanceof Error ? error.message : String(error),
      )
    } finally {
      this.refreshing = false
    }
  }

  private async loadActiveSources(): Promise<MtapiOrderUpdateSource[]> {
    const byBroker = new Map<string, MtapiOrderUpdateSource>()
    const brokerIds = new Set<string>()

    const { data: socialSubs, error: socialError } = await this.supabase
      .from('social_copy_subscriptions')
      .select('source_id')
      .eq('desired_status', 'active')
      .in('status', ['pending', 'active', 'error'])
    if (socialError) throw socialError

    const sourceIds = [...new Set(
      (socialSubs ?? [])
        .map(row => String((row as { source_id?: string }).source_id ?? '').trim())
        .filter(Boolean),
    )]
    if (sourceIds.length > 0) {
      const { data: sources, error: sourceError } = await this.supabase
        .from('social_copy_sources')
        .select('broker_account_id,status')
        .in('id', sourceIds)
        .eq('status', 'published')
      if (sourceError) throw sourceError
      for (const row of sources ?? []) {
        const brokerAccountId = String((row as { broker_account_id?: string }).broker_account_id ?? '').trim()
        if (brokerAccountId) brokerIds.add(brokerAccountId)
      }
    }

    const { data: mirrorStates, error: mirrorStateError } = await this.supabase
      .from('mirror_copy_link_state')
      .select('link_id')
      .eq('desired_status', 'active')
    if (mirrorStateError) {
      // Mirror tables may be absent on some environments — fail soft.
      if (!/does not exist|relation|schema cache/i.test(mirrorStateError.message)) throw mirrorStateError
    } else {
      const linkIds = [...new Set(
        (mirrorStates ?? [])
          .map(row => String((row as { link_id?: string }).link_id ?? '').trim())
          .filter(Boolean),
      )]
      if (linkIds.length > 0) {
        const { data: mirrorLinks, error: mirrorLinkError } = await this.supabase
          .from('broker_copy_links')
          .select('source_broker_account_id')
          .in('id', linkIds)
        if (mirrorLinkError) throw mirrorLinkError
        for (const row of mirrorLinks ?? []) {
          const brokerAccountId = String((row as { source_broker_account_id?: string }).source_broker_account_id ?? '').trim()
          if (brokerAccountId) brokerIds.add(brokerAccountId)
        }
      }
    }

    const allIds = [...brokerIds]
    if (allIds.length === 0) return []

    const { data: brokers, error: brokerError } = await this.supabase
      .from('broker_accounts')
      .select('id,provider,platform,mtapi_session_id,is_active')
      .in('id', allIds)
    if (brokerError) throw brokerError

    for (const row of brokers ?? []) {
      const broker = row as {
        id: string
        provider: string | null
        platform: string | null
        mtapi_session_id: string | null
        is_active: boolean | null
      }
      if (!broker.is_active) continue
      if (String(broker.provider ?? '').toLowerCase() !== 'mtapi') continue
      const sessionId = String(broker.mtapi_session_id ?? '').trim()
      if (!sessionId || sessionId.includes('|')) continue
      byBroker.set(broker.id, {
        brokerAccountId: broker.id,
        sessionId,
        platform: broker.platform,
      })
    }
    return [...byBroker.values()]
  }
}

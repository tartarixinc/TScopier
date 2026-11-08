import assert from 'node:assert/strict'
import test from 'node:test'
import { MtapiOrderUpdateHub } from './mtapiOrderUpdateHub'
import type { MtapiWsClientOptions } from './mtapiWsClient'

type Row = Record<string, unknown>

class Query implements PromiseLike<{ data: unknown; error: Row | null }> {
  private filters: Array<(row: Row) => boolean> = []
  private wantsSingle = false
  constructor(private db: FakeDb, private table: string) {}
  select(): this { return this }
  eq(key: string, value: unknown): this { this.filters.push(row => row[key] === value); return this }
  in(key: string, values: unknown[]): this { this.filters.push(row => values.includes(row[key])); return this }
  single(): this { this.wantsSingle = true; return this }
  then<TResult1 = { data: unknown; error: Row | null }, TResult2 = never>(
    resolve?: ((value: { data: unknown; error: Row | null }) => TResult1 | PromiseLike<TResult1>) | null,
    reject?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    const rows = (this.db.tables[this.table] ?? []).filter(row => this.filters.every(filter => filter(row)))
    const data = this.wantsSingle ? (rows[0] ?? null) : rows
    return Promise.resolve({ data, error: null }).then(resolve, reject)
  }
}

class FakeDb {
  tables: Record<string, Row[]> = {
    social_copy_subscriptions: [
      { id: 'sub-1', source_id: 'source-1', desired_status: 'active', status: 'active' },
    ],
    social_copy_sources: [
      { id: 'source-1', broker_account_id: 'src-mt', status: 'published' },
    ],
    mirror_copy_link_state: [
      { link_id: 'link-1', desired_status: 'active' },
    ],
    broker_copy_links: [
      { id: 'link-1', source_broker_account_id: 'src-mt' },
    ],
    broker_accounts: [
      {
        id: 'src-mt',
        provider: 'mtapi',
        platform: 'MT5',
        mtapi_session_id: 'session-abc',
        is_active: true,
      },
    ],
  }
  from = (table: string): Query => new Query(this, table)
}

class FakeWsClient {
  readonly opts: MtapiWsClientOptions
  connected = false
  closed = false
  private handler: ((event: { copyRelevant: boolean; updateType: string | null; raw: unknown }) => void) | null = null
  constructor(opts: MtapiWsClientOptions) {
    this.opts = opts
  }
  onMessage(handler: (event: { copyRelevant: boolean; updateType: string | null; raw: unknown }) => void): () => void {
    this.handler = handler
    return () => { this.handler = null }
  }
  connect(): void { this.connected = true }
  close(): void { this.closed = true; this.connected = false }
  emit(copyRelevant = true): void {
    this.handler?.({ copyRelevant, updateType: copyRelevant ? 'marketopen' : 'balance', raw: {} })
  }
}

test('hub opens one socket per active MTAPI source and debounces pokes', async () => {
  const db = new FakeDb()
  const pokes: string[] = []
  const clients: FakeWsClient[] = []
  const hub = new MtapiOrderUpdateHub({
    supabase: db as never,
    debounceMs: 20,
    refreshIntervalMs: 60_000,
    onSourceUpdate: (id) => { pokes.push(id) },
    createClient: (opts) => {
      const client = new FakeWsClient(opts)
      clients.push(client)
      return client as never
    },
  })

  await hub.refresh()
  assert.equal(hub.sessionCount, 1)
  assert.equal(clients.length, 1)
  assert.equal(clients[0]?.opts.sessionId, 'session-abc')
  assert.equal(clients[0]?.connected, true)

  assert.ok(clients[0], 'expected a live WS client')
  clients[0]!.emit(true)
  clients[0]!.emit(true)
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.deepEqual(pokes, ['src-mt'])

  // Drop membership → socket closed.
  db.tables.social_copy_subscriptions = []
  db.tables.mirror_copy_link_state = []
  await hub.refresh()
  assert.equal(hub.sessionCount, 0)
  assert.equal(clients[0]?.closed, true)
  hub.stop()
})

test('hub ignores non-relevant updates', async () => {
  const db = new FakeDb()
  const pokes: string[] = []
  const clients: FakeWsClient[] = []
  const hub = new MtapiOrderUpdateHub({
    supabase: db as never,
    debounceMs: 10,
    onSourceUpdate: (id) => { pokes.push(id) },
    createClient: (opts) => {
      const client = new FakeWsClient(opts)
      clients.push(client)
      return client as never
    },
  })
  await hub.refresh()
  clients[0]?.emit(false)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.deepEqual(pokes, [])
  hub.stop()
})

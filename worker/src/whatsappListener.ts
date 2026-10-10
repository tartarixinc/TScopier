/**
 * One Baileys socket per linked WhatsApp account.
 * Shard with WORKER_SHARD_ID / WORKER_SHARD_COUNT so two replicas never open the same creds.
 * This process only reads group text. It does not send messages or manage groups.
 */
import 'dotenv/config'
import http from 'node:http'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { isWhatsAppGroupJid, whatsappMessageText, type WhatsAppMessageContent } from './whatsappMessage'
import { parseRawChannelMessage } from './parseSignal'
import { pushParsedSignalToTradeWorker } from './tradeSignalPush'
import { userBelongsToShard } from './workerConfig'

type SessionStatus = 'qr' | 'connected' | 'disconnected'

type LiveSession = {
  userId: string
  sock: BaileysSocket | null
  qr: string | null
  status: SessionStatus
  groups: Array<{ group_jid: string; name: string }>
  saveCreds: () => Promise<void>
  retireAuth: () => void
  logoutRequested: boolean
  reconnectTimer: ReturnType<typeof setTimeout> | null
}

type BaileysSocket = {
  user?: { id?: string; name?: string } | null
  ev: {
    on: (event: string, handler: (payload: never) => void) => void
  }
  groupFetchAllParticipating: () => Promise<Record<string, { id?: string; subject?: string }>>
  logout: () => Promise<void>
  end: (error: Error | undefined) => void
}

type AuthBucket = Record<string, Record<string, unknown>>

const PORT = Math.max(1, Number(process.env.WHATSAPP_LISTENER_PORT ?? 8091))
const sessions = new Map<string, LiveSession>()

function requireEnv(name: string): string {
  const value = String(process.env[name] ?? '').trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function json(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  const origin = res.getHeader('access-control-allow-origin')
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': typeof origin === 'string' ? origin : '*',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  })
  res.end(JSON.stringify(body))
}

async function readUserId(supabase: SupabaseClient, req: http.IncomingMessage): Promise<string | null> {
  const header = String(req.headers.authorization ?? '')
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
  if (!token) return null
  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data.user) return null
  return data.user.id
}

async function useSupabaseAuthState(supabase: SupabaseClient, userId: string) {
  const baileys = await import('@whiskeysockets/baileys')
  const { data } = await supabase
    .from('whatsapp_auth')
    .select('creds, keys')
    .eq('user_id', userId)
    .maybeSingle()
  const stored = data as { creds?: unknown; keys?: unknown } | null
  const creds = stored?.creds
    ? JSON.parse(JSON.stringify(stored.creds), baileys.BufferJSON.reviver)
    : baileys.initAuthCreds()
  const keys: AuthBucket = stored?.keys
    ? JSON.parse(JSON.stringify(stored.keys), baileys.BufferJSON.reviver)
    : {}

  let retired = false
  const save = async () => {
    if (retired) return
    const payload = JSON.parse(JSON.stringify({ creds, keys }, baileys.BufferJSON.replacer)) as {
      creds: unknown
      keys: unknown
    }
    await supabase.from('whatsapp_auth').upsert({
      user_id: userId,
      creds: payload.creds,
      keys: payload.keys,
      updated_at: new Date().toISOString(),
    })
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type: string, ids: string[]) => {
          const bucket = keys[type] ?? {}
          const result: Record<string, unknown> = {}
          for (const id of ids) {
            let value = bucket[id]
            if (!value) continue
            if (type === 'app-state-sync-key') {
              value = baileys.proto.Message.AppStateSyncKeyData.fromObject(value)
            }
            result[id] = value
          }
          return result
        },
        set: async (data: AuthBucket) => {
          for (const type of Object.keys(data)) {
            keys[type] = keys[type] ?? {}
            for (const id of Object.keys(data[type] ?? {})) {
              const value = data[type]?.[id]
              if (value) keys[type][id] = value
              else delete keys[type][id]
            }
          }
          await save()
        },
      },
    },
    saveCreds: async () => {
      await save()
    },
    retire: () => {
      retired = true
    },
  }
}

async function setSessionStatus(
  supabase: SupabaseClient,
  userId: string,
  status: SessionStatus,
  phone = '',
  displayName = '',
): Promise<void> {
  const patch: Record<string, string> = {
    user_id: userId,
    status,
    updated_at: new Date().toISOString(),
  }
  if (phone) patch.phone = phone
  if (displayName) patch.display_name = displayName
  const { error } = await supabase.from('whatsapp_sessions').upsert(patch)
  if (error) console.warn(`[whatsapp] session status failed user=${userId}: ${error.message}`)
}

function phoneFromJid(jid: string | undefined): string {
  if (!jid) return ''
  return jid.split(':')[0]?.split('@')[0] ?? ''
}

async function copyGroupMessage(
  supabase: SupabaseClient,
  userId: string,
  groupJid: string,
  messageId: string,
  text: string,
): Promise<void> {
  const { data, error } = await supabase
    .from('whatsapp_groups')
    .select('channel_id, is_active, telegram_channels!inner(is_active, source_kind)')
    .eq('user_id', userId)
    .eq('group_jid', groupJid)
    .maybeSingle()
  if (error || !data) return
  const row = data as {
    channel_id: string
    is_active: boolean
    telegram_channels: { is_active?: boolean; source_kind?: string } | { is_active?: boolean; source_kind?: string }[]
  }
  const shadow = Array.isArray(row.telegram_channels) ? row.telegram_channels[0] : row.telegram_channels
  if (!row.is_active || !shadow?.is_active || shadow.source_kind !== 'whatsapp') return

  const parsed = await parseRawChannelMessage(supabase, row.channel_id, text)
  if (parsed.status !== 'parsed' || parsed.parsed.action === 'ignore') return
  const signalId = crypto.randomUUID()
  const createdAt = new Date().toISOString()
  const { error: insertError } = await supabase.from('signals').insert({
    id: signalId,
    user_id: userId,
    channel_id: row.channel_id,
    raw_message: text,
    parsed_data: parsed.parsed,
    status: 'parsed',
    skip_reason: null,
    telegram_message_id: messageId,
    is_modification: false,
    created_at: createdAt,
  })
  if (insertError) {
    if (insertError.code !== '23505') {
      console.warn(`[whatsapp] signal insert failed user=${userId}: ${insertError.message}`)
    }
    return
  }
  pushParsedSignalToTradeWorker({
    id: signalId,
    user_id: userId,
    channel_id: row.channel_id,
    parsed_data: parsed.parsed,
    status: 'parsed',
    telegram_message_id: messageId,
    is_modification: false,
    created_at: createdAt,
    dispatch_source: 'whatsapp',
  }, { source: 'whatsapp' })
}

async function openSocket(supabase: SupabaseClient, userId: string): Promise<LiveSession> {
  const existing = sessions.get(userId)
  if (existing?.sock && existing.status !== 'disconnected') return existing

  const baileys = await import('@whiskeysockets/baileys')
  const auth = await useSupabaseAuthState(supabase, userId)
  let version: [number, number, number] | undefined
  try {
    version = (await baileys.fetchLatestBaileysVersion()).version
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.warn(`[whatsapp] version lookup failed: ${detail}`)
  }
  const sock = baileys.default({
    version,
    auth: auth.state as never,
    printQRInTerminal: false,
    syncFullHistory: false,
    fireInitQueries: false,
    shouldSyncHistoryMessage: () => false,
    markOnlineOnConnect: false,
    browser: baileys.Browsers.macOS('UniCopier'),
  }) as unknown as BaileysSocket

  const live: LiveSession = existing ?? {
    userId,
    sock: null,
    qr: null,
    status: 'disconnected',
    groups: [],
    saveCreds: auth.saveCreds,
    retireAuth: auth.retire,
    logoutRequested: false,
    reconnectTimer: null,
  }
  live.sock = sock
  live.saveCreds = auth.saveCreds
  live.retireAuth = auth.retire
  live.logoutRequested = false
  sessions.set(userId, live)

  sock.ev.on('creds.update', () => {
    if (live.logoutRequested) return
    void auth.saveCreds()
  })
  sock.ev.on('connection.update', (update: { connection?: string; qr?: string; lastDisconnect?: { error?: { output?: { statusCode?: number } } } }) => {
    if (update.qr) {
      live.qr = update.qr
      live.status = 'qr'
      void setSessionStatus(supabase, userId, 'qr')
    }
    if (update.connection === 'open') {
      live.qr = null
      live.status = 'connected'
      const phone = phoneFromJid(sock.user?.id)
      const name = sock.user?.name ?? ''
      void setSessionStatus(supabase, userId, 'connected', phone, name)
      console.log(`[whatsapp] connected user=${userId}`)
    }
    if (update.connection === 'close') {
      const code = update.lastDisconnect?.error?.output?.statusCode
      const loggedOut = code === baileys.DisconnectReason.loggedOut || live.logoutRequested
      live.sock = null
      live.qr = null
      if (loggedOut) {
        live.logoutRequested = true
        live.retireAuth()
        live.status = 'disconnected'
        void setSessionStatus(supabase, userId, 'disconnected')
        console.log(`[whatsapp] logged out user=${userId} code=${code ?? 'unknown'}`)
        return
      }
      // After a QR scan WhatsApp closes the socket (515) and expects an immediate restart.
      // Leaving status as "qr" keeps the page on the linking screen instead of the welcome banner.
      live.status = 'qr'
      console.log(`[whatsapp] closed user=${userId} code=${code ?? 'unknown'}, reconnecting`)
      if (live.reconnectTimer) clearTimeout(live.reconnectTimer)
      const delay = code === baileys.DisconnectReason.restartRequired ? 0 : 2_000
      live.reconnectTimer = setTimeout(() => {
        live.reconnectTimer = null
        void openSocket(supabase, userId).catch(err => {
          const detail = err instanceof Error ? err.message : String(err)
          console.warn(`[whatsapp] reconnect failed user=${userId}: ${detail}`)
        })
      }, delay)
    }
  })
  sock.ev.on('messages.upsert', (payload: { type?: string; messages?: Array<{ key?: { remoteJid?: string | null; id?: string | null }; message?: WhatsAppMessageContent | null }> }) => {
    if (payload.type !== 'notify') return
    for (const message of payload.messages ?? []) {
      const jid = message.key?.remoteJid
      const messageId = message.key?.id
      if (!isWhatsAppGroupJid(jid) || !messageId) continue
      const text = whatsappMessageText(message.message)
      if (!text) continue
      void copyGroupMessage(supabase, userId, jid, messageId, text).catch(err => {
        const detail = err instanceof Error ? err.message : String(err)
        console.warn(`[whatsapp] copy failed user=${userId}: ${detail}`)
      })
    }
  })
  return live
}

async function waitForPair(live: LiveSession): Promise<void> {
  const started = Date.now()
  while (!live.qr && live.status !== 'connected' && Date.now() - started < 20_000) {
    if (live.logoutRequested && !live.sock) break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

async function forgetAuth(supabase: SupabaseClient, userId: string): Promise<void> {
  const live = sessions.get(userId)
  if (live) {
    live.logoutRequested = true
    live.retireAuth()
    if (live.reconnectTimer) clearTimeout(live.reconnectTimer)
    try {
      live.sock?.end(undefined)
    } catch {
      // The socket is already closed when WhatsApp removes the linked device.
    }
    sessions.delete(userId)
  }
  await supabase.from('whatsapp_auth').delete().eq('user_id', userId)
}

async function listGroups(live: LiveSession): Promise<Array<{ group_jid: string; name: string }>> {
  if (!live.sock || live.status !== 'connected') return live.groups
  const participating = await live.sock.groupFetchAllParticipating()
  live.groups = Object.values(participating)
    .filter(group => isWhatsAppGroupJid(group.id))
    .map(group => ({ group_jid: String(group.id), name: group.subject?.trim() || 'WhatsApp group' }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return live.groups
}

async function handle(supabase: SupabaseClient, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const origin = String(req.headers.origin ?? '*')
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const userId = await readUserId(supabase, req)
  if (!userId) return json(res, 401, { error: 'unauthorized' })
  if (!userBelongsToShard(userId)) return json(res, 409, { error: 'wrong_shard' })

  if (req.method === 'GET' && url.pathname === '/whatsapp/status') {
    const live = sessions.get(userId)
    return json(res, 200, {
      status: live?.status ?? 'disconnected',
      qr: live?.qr ?? null,
    })
  }

  if (req.method === 'POST' && url.pathname === '/whatsapp/pair') {
    let live = await openSocket(supabase, userId)
    await waitForPair(live)
    if (!live.qr && live.status !== 'connected') {
      // The saved link was removed on the phone. Drop it and ask WhatsApp for a new QR.
      await forgetAuth(supabase, userId)
      live = await openSocket(supabase, userId)
      await waitForPair(live)
    }
    if (!live.qr && live.status !== 'connected') {
      return json(res, 409, { error: 'WhatsApp did not return a QR code. Click Connect again.' })
    }
    return json(res, 200, { status: live.status, qr: live.qr })
  }

  if (req.method === 'GET' && url.pathname === '/whatsapp/groups') {
    const live = sessions.get(userId)
    if (!live || live.status !== 'connected') return json(res, 409, { error: 'not_connected' })
    const groups = await listGroups(live)
    return json(res, 200, { groups })
  }

  if (req.method === 'POST' && url.pathname === '/whatsapp/logout') {
    const live = sessions.get(userId)
    if (live) {
      live.logoutRequested = true
      live.retireAuth()
      if (live.reconnectTimer) clearTimeout(live.reconnectTimer)
      try {
        await live.sock?.logout()
      } catch {
        live.sock?.end(undefined)
      }
      sessions.delete(userId)
    }
    await supabase.from('whatsapp_auth').delete().eq('user_id', userId)
    await setSessionStatus(supabase, userId, 'disconnected')
    return json(res, 200, { status: 'disconnected' })
  }

  return json(res, 404, { error: 'not_found' })
}

async function resumeConnected(supabase: SupabaseClient): Promise<void> {
  const { data } = await supabase.from('whatsapp_sessions').select('user_id').eq('status', 'connected')
  for (const row of (data ?? []) as Array<{ user_id: string }>) {
    if (!userBelongsToShard(row.user_id)) continue
    void openSocket(supabase, row.user_id).catch(err => {
      const detail = err instanceof Error ? err.message : String(err)
      console.warn(`[whatsapp] resume failed user=${row.user_id}: ${detail}`)
    })
  }
}

function whatsappSupabase(): SupabaseClient {
  // The browser session belongs to the app project. Validating it against a
  // different project returns unauthorized.
  const url = String(process.env.WHATSAPP_SUPABASE_URL ?? '').trim() || requireEnv('SUPABASE_URL')
  const key = String(process.env.WHATSAPP_SUPABASE_SERVICE_ROLE_KEY ?? '').trim() || requireEnv('SUPABASE_SERVICE_ROLE_KEY')
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

async function main(): Promise<void> {
  const supabase = whatsappSupabase()
  const server = http.createServer((req, res) => {
    void handle(supabase, req, res).catch(err => {
      const detail = err instanceof Error ? err.message : String(err)
      console.warn(`[whatsapp] request failed: ${detail}`)
      if (!res.headersSent) json(res, 500, { error: 'listener_failed' })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.listen(PORT, () => resolve())
    server.on('error', reject)
  })
  const host = new URL(String(process.env.WHATSAPP_SUPABASE_URL ?? process.env.SUPABASE_URL ?? '')).host
  console.log(`[whatsapp] listener listening on ${PORT} (${host})`)
  await resumeConnected(supabase)
}

main().catch(err => {
  console.error('[whatsapp] listener stopped', err)
  process.exit(1)
})

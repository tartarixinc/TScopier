/** FxSocket GET /mt5/{id}/status — health snapshot (OpenAPI schema). */

export interface FxsocketMtStatusTerminal {
  alive?: boolean
  build?: number
  pingMs?: number
}

export interface FxsocketMtStatusBroker {
  connected?: boolean
  server?: string
}

export interface FxsocketMtStatusAccount {
  loggedIn?: boolean
  login?: number
  currency?: string
  type?: string
  tradeAllowed?: boolean
  /** Bybit: the account's margin mode (ISOLATED_MARGIN, REGULAR_MARGIN, PORTFOLIO_MARGIN). KuCoin: isolated or cross. */
  marginMode?: string
}

export interface FxsocketMtStatusBridge {
  version?: string
  tradeEaReady?: boolean
  symbolsSynced?: boolean
}

export interface FxsocketMtStatus {
  status?: string
  serverTime?: string
  terminal?: FxsocketMtStatusTerminal
  broker?: FxsocketMtStatusBroker
  account?: FxsocketMtStatusAccount
  bridge?: FxsocketMtStatusBridge
}

export type FxsocketMtStatusCheckId =
  | 'statusReady'
  | 'terminalAlive'
  | 'brokerConnected'
  | 'accountLoggedIn'
  | 'accountTradeAllowed'
  | 'bridgeTradeEaReady'
  | 'bridgeSymbolsSynced'

export interface FxsocketMtStatusCheck {
  id: FxsocketMtStatusCheckId
  ok: boolean
  value?: string | number | boolean | null
}

function num(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

function boolField(v: unknown): boolean | undefined {
  if (v === null || v === undefined) return undefined
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (s === 'true' || s === '1' || s === 'yes') return true
    if (s === 'false' || s === '0' || s === 'no') return false
  }
  return undefined
}

function nestedObject(raw: unknown): Record<string, unknown> {
  return (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {}
}

export function normalizeFxsocketMtStatus(raw: unknown): FxsocketMtStatus {
  const o = nestedObject(raw)
  const terminal = nestedObject(o.terminal)
  const broker = nestedObject(o.broker)
  const account = nestedObject(o.account)
  const bridge = nestedObject(o.bridge)

  return {
    status: o.status != null ? String(o.status) : undefined,
    serverTime: o.serverTime != null
      ? String(o.serverTime)
      : o.server_time != null
        ? String(o.server_time)
        : undefined,
    terminal: {
      alive: boolField(terminal.alive ?? terminal.Alive),
      build: num(terminal.build ?? terminal.Build),
      pingMs: num(terminal.pingMs ?? terminal.ping_ms ?? terminal.PingMs),
    },
    broker: {
      connected: boolField(broker.connected ?? broker.Connected),
      server: broker.server != null ? String(broker.server) : undefined,
    },
    account: {
      loggedIn: boolField(account.loggedIn ?? account.LoggedIn ?? account.logged_in),
      login: num(account.login ?? account.Login),
      currency: account.currency != null ? String(account.currency) : undefined,
      type: account.type != null ? String(account.type) : undefined,
      marginMode: account.marginMode != null ? String(account.marginMode) : undefined,
      tradeAllowed: boolField(
        account.tradeAllowed ?? account.TradeAllowed ?? account.trade_allowed,
      ),
    },
    bridge: {
      version: bridge.version != null ? String(bridge.version) : undefined,
      tradeEaReady: boolField(
        bridge.tradeEaReady ?? bridge.TradeEaReady ?? bridge.trade_ea_ready,
      ),
      symbolsSynced: boolField(
        bridge.symbolsSynced ?? bridge.SymbolsSynced ?? bridge.symbols_synced,
      ),
    },
  }
}

export function isFxsocketMtStatusHealthy(status: FxsocketMtStatus): boolean {
  return listFxsocketMtStatusChecks(status).every(check => check.ok)
}

export function listFxsocketMtStatusChecks(status: FxsocketMtStatus): FxsocketMtStatusCheck[] {
  const statusValue = (status.status ?? '').trim().toLowerCase()
  return [
    { id: 'statusReady', ok: statusValue === 'ready', value: status.status ?? null },
    { id: 'terminalAlive', ok: status.terminal?.alive === true, value: status.terminal?.alive ?? null },
    { id: 'brokerConnected', ok: status.broker?.connected === true, value: status.broker?.connected ?? null },
    { id: 'accountLoggedIn', ok: status.account?.loggedIn === true, value: status.account?.loggedIn ?? null },
    {
      id: 'accountTradeAllowed',
      ok: status.account?.tradeAllowed === true,
      value: status.account?.tradeAllowed ?? null,
    },
    {
      id: 'bridgeTradeEaReady',
      ok: status.bridge?.tradeEaReady === true,
      value: status.bridge?.tradeEaReady ?? null,
    },
    {
      id: 'bridgeSymbolsSynced',
      ok: status.bridge?.symbolsSynced === true,
      value: status.bridge?.symbolsSynced ?? null,
    },
  ]
}

export function terminalHealthRowPatchFromMtStatus(status: FxsocketMtStatus): {
  terminal_connected: boolean | null
  trade_allowed: boolean | null
} {
  const terminalOk = status.terminal?.alive === true && status.broker?.connected === true
  const tradeAllowed = status.account?.tradeAllowed
  return {
    terminal_connected: terminalOk ? true : (terminalOk === false ? false : null),
    trade_allowed: tradeAllowed ?? null,
  }
}

export function legacyTerminalStatusFromMtStatus(status: FxsocketMtStatus): {
  connected?: boolean
  tradeAllowed?: boolean
  loggedIn?: boolean
  serverTime?: string
} {
  const patch = terminalHealthRowPatchFromMtStatus(status)
  return {
    connected: patch.terminal_connected ?? undefined,
    tradeAllowed: patch.trade_allowed ?? undefined,
    loggedIn: status.account?.loggedIn,
    serverTime: status.serverTime,
  }
}

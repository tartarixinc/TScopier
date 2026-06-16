import type { BrokerAccount } from '../types/database'
import { countLinkedBrokerSessions } from './brokerLink'
import {
  emptyConnectTradingAccountForm,
  type ConnectTradingAccountForm,
} from './connectTradingAccountForm'
import { type TradingPlatform } from './tradingPlatform'

export const CONNECT_ACCOUNTS_CSV_TEMPLATE = `label,platform,broker_server,login,password
Live MT5,MT5,ICMarketsSC-MT5,12345678,your_password
Live MT4,MT4,ICMarketsSC-MT4,87654321,your_password
`

export type BulkConnectRowStatus =
  | 'queued'
  | 'linking'
  | 'linked'
  | 'failed'
  | 'skipped_duplicate'
  | 'skipped_limit'
  | 'skipped_invalid'

export interface BulkConnectRowProgress {
  index: number
  row: ConnectTradingAccountForm
  status: BulkConnectRowStatus
  error?: string
  account?: BrokerAccount
}

export interface BulkConnectResult {
  rows: BulkConnectRowProgress[]
  linkedCount: number
  failedCount: number
  skippedCount: number
}

export interface CsvParseRowError {
  line: number
  message: string
}

export interface CsvParseResult {
  rows: ConnectTradingAccountForm[]
  errors: CsvParseRowError[]
}

const LABEL_KEYS = new Set(['label', 'account_label', 'name'])
const PLATFORM_KEYS = new Set(['platform', 'mt_platform'])
const SERVER_KEYS = new Set(['broker_server', 'server', 'broker'])
const LOGIN_KEYS = new Set(['login', 'mt_login', 'account_number', 'account'])
const PASSWORD_KEYS = new Set(['password', 'account_password', 'pass'])

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '_')
}

/** Minimal RFC 4180-style CSV row parser (handles quoted fields). */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const next = text[i + 1]

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"'
        i++
      } else if (ch === '"') {
        inQuotes = false
      } else {
        field += ch
      }
      continue
    }

    if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || (ch === '\r' && next === '\n')) {
      row.push(field)
      field = ''
      if (row.some(cell => cell.trim().length > 0)) rows.push(row)
      row = []
      if (ch === '\r') i++
    } else if (ch !== '\r') {
      field += ch
    }
  }

  row.push(field)
  if (row.some(cell => cell.trim().length > 0)) rows.push(row)
  return rows
}

function mapCsvHeaders(headers: string[]): Map<string, number> | null {
  const indexByKey = new Map<string, number>()
  for (let i = 0; i < headers.length; i++) {
    indexByKey.set(normalizeHeader(headers[i] ?? ''), i)
  }

  const resolve = (keys: Set<string>): number | undefined => {
    for (const key of keys) {
      const idx = indexByKey.get(key)
      if (idx != null) return idx
    }
    return undefined
  }

  const serverIdx = resolve(SERVER_KEYS)
  const loginIdx = resolve(LOGIN_KEYS)
  const passwordIdx = resolve(PASSWORD_KEYS)
  if (serverIdx == null || loginIdx == null || passwordIdx == null) return null

  const labelIdx = resolve(LABEL_KEYS)
  const platformIdx = resolve(PLATFORM_KEYS)
  const out = new Map<string, number>()
  out.set('server', serverIdx)
  out.set('login', loginIdx)
  out.set('password', passwordIdx)
  if (labelIdx != null) out.set('label', labelIdx)
  if (platformIdx != null) out.set('platform', platformIdx)
  return out
}

function parseCsvPlatform(raw: string, hasPlatformColumn: boolean): TradingPlatform | string {
  const trimmed = raw.trim()
  if (!trimmed) return 'MT5'
  const upper = trimmed.toUpperCase()
  if (upper === 'MT4' || upper === 'MT5') return upper
  if (hasPlatformColumn) return `Invalid platform "${trimmed}". Use MT4 or MT5.`
  return 'MT5'
}

function rowFromCsvCells(
  cells: string[],
  columnMap: Map<string, number>,
  hasPlatformColumn: boolean,
): ConnectTradingAccountForm | { error: string } {
  const get = (key: string) => {
    const idx = columnMap.get(key)
    return idx == null ? '' : (cells[idx] ?? '').trim()
  }
  const platform = parseCsvPlatform(get('platform'), hasPlatformColumn)
  if (typeof platform === 'string' && platform.startsWith('Invalid platform')) {
    return { error: platform }
  }
  return {
    label: get('label'),
    platform: platform as TradingPlatform,
    broker_server: get('server'),
    account_number: get('login'),
    account_password: get('password'),
  }
}

export function validateConnectRow(row: ConnectTradingAccountForm): string | null {
  if (!row.broker_server.trim()) return 'Broker server is required'
  if (!row.account_number.trim()) return 'MT login is required'
  if (!row.account_password) return 'Password is required'
  return null
}

export function brokerLoginServerKey(login: string, server: string): string {
  return `${login.trim()}::${server.trim()}`
}

export function isDuplicateBrokerLogin(
  login: string,
  server: string,
  existingBrokers: readonly BrokerAccount[],
): boolean {
  const key = brokerLoginServerKey(login, server)
  return existingBrokers.some(
    b => brokerLoginServerKey(b.account_login ?? '', b.broker_server ?? '') === key,
  )
}

export function parseConnectAccountsCsv(text: string): CsvParseResult {
  const parsed = parseCsvRows(text)
  if (parsed.length === 0) {
    return { rows: [], errors: [{ line: 1, message: 'CSV file is empty' }] }
  }

  const columnMap = mapCsvHeaders(parsed[0] ?? [])
  if (!columnMap) {
    return {
      rows: [],
      errors: [{
        line: 1,
        message: 'Missing required columns. Expected broker_server, login, and password.',
      }],
    }
  }

  const hasPlatformColumn = columnMap.has('platform')

  const rows: ConnectTradingAccountForm[] = []
  const errors: CsvParseRowError[] = []

  for (let i = 1; i < parsed.length; i++) {
    const line = i + 1
    const parsedRow = rowFromCsvCells(parsed[i] ?? [], columnMap, hasPlatformColumn)
    if ('error' in parsedRow) {
      errors.push({ line, message: parsedRow.error })
      continue
    }
    const row = parsedRow
    const allEmpty = !row.label && !row.broker_server && !row.account_number && !row.account_password
    if (allEmpty) continue

    const validationError = validateConnectRow(row)
    if (validationError) {
      errors.push({ line, message: validationError })
      continue
    }
    rows.push(row)
  }

  return { rows, errors }
}

export function downloadConnectAccountsTemplate(filename = 'tscopier-mt-accounts-template.csv'): void {
  const blob = new Blob([CONNECT_ACCOUNTS_CSV_TEMPLATE], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export type ConnectAccountsBatchArgs = {
  rows: ConnectTradingAccountForm[]
  existingBrokers: BrokerAccount[]
  /** Active broker rows already linked before this batch starts. */
  activeBrokerCountAtStart: number
  /** Null when admin / unlimited. */
  maxBrokerAccounts: number | null
  onProgress: (rows: BulkConnectRowProgress[]) => void
  connect?: (args: {
    login?: string
    password?: string
    server?: string
    label?: string
    platform?: TradingPlatform
  }) => Promise<{ account: BrokerAccount; pending?: boolean }>
  /** Known brokers accumulated during the batch (for timeout recovery). */
  getKnownBrokers?: () => BrokerAccount[]
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    if (typeof window !== 'undefined') {
      window.setTimeout(resolve, ms)
    } else {
      setTimeout(resolve, ms)
    }
  })
}

function isRecoverableConnectError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()
  return /timed out|timeout|abort|network|failed to fetch|load failed|gateway|504|502/i.test(msg)
}

function isBrokerLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()
  return /broker account limit|allows \d+ broker|upgrade to advanced|subscription is required/i.test(msg)
}

export function canLinkAnotherBrokerInBatch(
  activeBrokerCountAtStart: number,
  linkedInBatch: number,
  maxBrokerAccounts: number | null,
): boolean {
  if (maxBrokerAccounts == null) return true
  return activeBrokerCountAtStart + linkedInBatch < maxBrokerAccounts
}

async function findLinkedBrokerAccount(
  login: string,
  server: string,
  knownBrokers: readonly BrokerAccount[],
): Promise<BrokerAccount | null> {
  const key = brokerLoginServerKey(login, server)
  const local = knownBrokers.find(
    b => brokerLoginServerKey(b.account_login ?? '', b.broker_server ?? '') === key,
  )
  if (local) return local

  try {
    const { fxsocketBroker } = await import('./fxsocketBroker')
    const remote = await fxsocketBroker.list()
    return remote.find(
      b => brokerLoginServerKey(b.account_login ?? '', b.broker_server ?? '') === key,
    ) ?? null
  } catch {
    return null
  }
}

export async function connectAccountsBatch(args: ConnectAccountsBatchArgs): Promise<BulkConnectResult> {
  const connect = args.connect ?? (async (connectArgs) => {
    const { fxsocketBroker, FXSOCKET_BULK_CONNECT_TIMEOUT_MS } = await import('./fxsocketBroker')
    return fxsocketBroker.connect({ ...connectArgs, timeoutMs: FXSOCKET_BULK_CONNECT_TIMEOUT_MS })
  })
  const progress: BulkConnectRowProgress[] = args.rows.map((row, index) => ({
    index,
    row,
    status: 'queued',
  }))

  const emit = () => args.onProgress(progress.map(entry => ({ ...entry })))

  const seenKeys = new Set(
    args.existingBrokers.map(b => brokerLoginServerKey(b.account_login ?? '', b.broker_server ?? '')),
  )

  let linkedCount = 0
  let failedCount = 0
  let skippedCount = 0

  emit()

  for (const entry of progress) {
    const validationError = validateConnectRow(entry.row)
    if (validationError) {
      entry.status = 'skipped_invalid'
      entry.error = validationError
      skippedCount++
      emit()
      continue
    }

    const login = entry.row.account_number.trim()
    const server = entry.row.broker_server.trim()
    const key = brokerLoginServerKey(login, server)

    if (seenKeys.has(key)) {
      entry.status = 'skipped_duplicate'
      entry.error = 'This MT login is already linked'
      skippedCount++
      emit()
      continue
    }

    if (!canLinkAnotherBrokerInBatch(args.activeBrokerCountAtStart, linkedCount, args.maxBrokerAccounts)) {
      entry.status = 'skipped_limit'
      entry.error = 'Broker account limit reached'
      skippedCount++
      emit()
      continue
    }

    entry.status = 'linking'
    emit()

    const knownBrokers = () => {
      const fromProgress = progress
        .map(row => row.account)
        .filter((account): account is BrokerAccount => account != null)
      const external = args.getKnownBrokers?.() ?? []
      return [...args.existingBrokers, ...external, ...fromProgress]
    }

    try {
      const { account } = await connect({
        login,
        password: entry.row.account_password,
        server,
        label: entry.row.label.trim() || undefined,
        platform: entry.row.platform,
      })
      entry.status = 'linked'
      entry.account = account
      seenKeys.add(key)
      linkedCount++
      emit()
    } catch (err) {
      let recovered: BrokerAccount | null = null
      if (isRecoverableConnectError(err)) {
        await sleep(2_000)
        recovered = await findLinkedBrokerAccount(login, server, knownBrokers())
      }

      if (recovered) {
        entry.status = 'linked'
        entry.account = recovered
        seenKeys.add(key)
        linkedCount++
        emit()
        continue
      }

      const msg = err instanceof Error ? err.message : 'Connect failed'
      if (isBrokerLimitError(err)) {
        entry.status = 'skipped_limit'
        entry.error = msg
        skippedCount++
      } else {
        entry.status = 'failed'
        entry.error = msg
        failedCount++
      }
      emit()
    }
  }

  return { rows: progress, linkedCount, failedCount, skippedCount }
}

export function emptyConnectRows(count = 1): ConnectTradingAccountForm[] {
  return Array.from({ length: count }, () => ({ ...emptyConnectTradingAccountForm }))
}

export function resolveActiveBrokerCount(
  brokers: readonly BrokerAccount[],
  usageCount: number,
): number {
  const activeBrokers = countLinkedBrokerSessions(brokers)
  return Math.max(activeBrokers, usageCount)
}

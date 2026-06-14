import type { BrokerAccount } from '../types/database'
import {
  emptyConnectTradingAccountForm,
  type ConnectTradingAccountForm,
} from './connectTradingAccountForm'

export const CONNECT_ACCOUNTS_CSV_TEMPLATE = `label,broker_server,login,password
Live Main,ICMarketsSC-MT5,12345678,your_password
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
  const out = new Map<string, number>()
  out.set('server', serverIdx)
  out.set('login', loginIdx)
  out.set('password', passwordIdx)
  if (labelIdx != null) out.set('label', labelIdx)
  return out
}

function rowFromCsvCells(
  cells: string[],
  columnMap: Map<string, number>,
): ConnectTradingAccountForm {
  const get = (key: string) => {
    const idx = columnMap.get(key)
    return idx == null ? '' : (cells[idx] ?? '').trim()
  }
  return {
    label: get('label'),
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

  const rows: ConnectTradingAccountForm[] = []
  const errors: CsvParseRowError[] = []

  for (let i = 1; i < parsed.length; i++) {
    const line = i + 1
    const row = rowFromCsvCells(parsed[i] ?? [], columnMap)
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

export function downloadConnectAccountsTemplate(filename = 'tscopier-mt5-accounts-template.csv'): void {
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
  canAddMore: () => boolean
  onProgress: (rows: BulkConnectRowProgress[]) => void
  connect?: (args: {
    login?: string
    password?: string
    server?: string
    label?: string
  }) => Promise<{ account: BrokerAccount; pending?: boolean }>
}

export async function connectAccountsBatch(args: ConnectAccountsBatchArgs): Promise<BulkConnectResult> {
  const connect = args.connect ?? (async (connectArgs) => {
    const { fxsocketBroker } = await import('./fxsocketBroker')
    return fxsocketBroker.connect(connectArgs)
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
  let linkedThisBatch = 0

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

    if (!args.canAddMore()) {
      entry.status = 'skipped_limit'
      entry.error = 'Broker account limit reached'
      skippedCount++
      emit()
      continue
    }

    entry.status = 'linking'
    emit()

    try {
      const { account } = await connect({
        login,
        password: entry.row.account_password,
        server,
        label: entry.row.label.trim() || undefined,
      })
      entry.status = 'linked'
      entry.account = account
      seenKeys.add(key)
      linkedCount++
      linkedThisBatch++
      emit()
    } catch (err) {
      entry.status = 'failed'
      entry.error = err instanceof Error ? err.message : 'Connect failed'
      failedCount++
      emit()
    }
  }

  void linkedThisBatch
  return { rows: progress, linkedCount, failedCount, skippedCount }
}

export function emptyConnectRows(count = 1): ConnectTradingAccountForm[] {
  return Array.from({ length: count }, () => ({ ...emptyConnectTradingAccountForm }))
}

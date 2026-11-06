export type SymbolMapRow = {
  master: string
  slave: string
}

/**
 * Convert a stored `symbol_mapping` record into editable rows. Entries with an
 * empty side are dropped, both sides are uppercased (matching the worker's
 * `parseSymbolMap` normalisation and the broker-config editor), and rows are
 * sorted by master symbol so the list is stable between renders.
 */
export function symbolMapRecordToRows(map: Record<string, string> | null | undefined): SymbolMapRow[] {
  if (!map) return []
  return Object.entries(map)
    .map(([master, slave]) => ({ master: normalizeSymbol(master), slave: normalizeSymbol(slave) }))
    .filter(row => row.master !== '' && row.slave !== '')
    .sort((a, b) => a.master.localeCompare(b.master))
}

/**
 * Convert editor rows back into a `symbol_mapping` record. Incomplete rows are
 * dropped (nothing is persisted until both sides are filled), both sides are
 * uppercased, and duplicate master symbols collapse with the last row winning
 * so the record stays a valid key/value map.
 */
export function symbolMapRowsToRecord(rows: SymbolMapRow[]): Record<string, string> {
  const record: Record<string, string> = {}
  for (const row of rows) {
    const master = normalizeSymbol(row.master)
    const slave = normalizeSymbol(row.slave)
    if (master === '' || slave === '') continue
    record[master] = slave
  }
  return record
}

export function normalizeSymbol(value: unknown): string {
  return String(value ?? '').trim().toUpperCase()
}

export type IdentifiedSymbolMapRow = SymbolMapRow & { id: string }

export function isCompleteSymbolMapRow(row: SymbolMapRow): boolean {
  return normalizeSymbol(row.master) !== '' && normalizeSymbol(row.slave) !== ''
}

/** True when both records hold the same keys with the same values. */
export function symbolMapsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  return aKeys.every(key => a[key] === b[key])
}

/**
 * Seed for the editor's retention map: every row it receives is complete (they
 * came from a stored record), keyed by row id, both sides normalised. Seeding
 * at mount is what guarantees the FIRST field clear in a session retains the
 * live mapping instead of deleting it.
 */
export function initialCommittedSymbolMap(rows: IdentifiedSymbolMapRow[]): Map<string, SymbolMapRow> {
  const committed = new Map<string, SymbolMapRow>()
  for (const row of rows) {
    if (!isCompleteSymbolMapRow(row)) continue
    committed.set(row.id, { master: normalizeSymbol(row.master), slave: normalizeSymbol(row.slave) })
  }
  return committed
}

/**
 * Build the record to persist for the current editor rows. Complete rows
 * contribute their fresh entry; rows that are transiently incomplete (a field
 * is being retyped) keep their last committed entry so a pause mid-edit never
 * deletes a live mapping — an explicit row removal is the only deletion path
 * (removed rows simply stop being passed in).
 */
export function buildSymbolMapRecord(
  rows: IdentifiedSymbolMapRow[],
  committed: Map<string, SymbolMapRow>,
): Record<string, string> {
  const record = symbolMapRowsToRecord(rows.filter(isCompleteSymbolMapRow))
  for (const row of rows) {
    if (isCompleteSymbolMapRow(row)) continue
    const previous = committed.get(row.id)
    if (previous) {
      record[normalizeSymbol(previous.master)] = normalizeSymbol(previous.slave)
    }
  }
  return record
}

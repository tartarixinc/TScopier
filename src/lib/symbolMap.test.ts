import { describe, expect, it } from 'vitest'
import {
  buildSymbolMapRecord,
  initialCommittedSymbolMap,
  isCompleteSymbolMapRow,
  symbolMapRecordToRows,
  symbolMapRowsToRecord,
  symbolMapsEqual,
} from './symbolMap'

describe('symbolMapRecordToRows', () => {
  it('uppercases both sides and sorts by master symbol', () => {
    expect(symbolMapRecordToRows({ xauusd: 'gold', eurusd: 'eurusd.r' })).toEqual([
      { master: 'EURUSD', slave: 'EURUSD.R' },
      { master: 'XAUUSD', slave: 'GOLD' },
    ])
  })

  it('drops entries whose side is empty or whitespace', () => {
    expect(symbolMapRecordToRows({ XAUUSD: '   ', ' ': 'GOLD', US30: 'US30.M' })).toEqual([
      { master: 'US30', slave: 'US30.M' },
    ])
  })

  it('returns an empty list for null, undefined, and empty records', () => {
    expect(symbolMapRecordToRows(null)).toEqual([])
    expect(symbolMapRecordToRows(undefined)).toEqual([])
    expect(symbolMapRecordToRows({})).toEqual([])
  })

  it('coerces non-string values instead of throwing', () => {
    expect(symbolMapRecordToRows({ XAUUSD: 123, EURUSD: null } as unknown as Record<string, string>)).toEqual([
      { master: 'XAUUSD', slave: '123' },
    ])
  })

  it('drops null and undefined values', () => {
    expect(symbolMapRecordToRows({ XAUUSD: null, EURUSD: undefined } as unknown as Record<string, string>)).toEqual([])
  })
})

describe('symbolMapRowsToRecord', () => {
  it('uppercases both sides', () => {
    expect(symbolMapRowsToRecord([{ master: 'xauusd', slave: 'gold' }])).toEqual({ XAUUSD: 'GOLD' })
  })

  it('drops rows with an empty side', () => {
    expect(symbolMapRowsToRecord([
      { master: 'XAUUSD', slave: '' },
      { master: '', slave: 'GOLD' },
      { master: '  ', slave: 'GOLD' },
      { master: 'US30', slave: 'US30.M' },
    ])).toEqual({ US30: 'US30.M' })
  })

  it('collapses duplicate master symbols with the last row winning', () => {
    expect(symbolMapRowsToRecord([
      { master: 'XAUUSD', slave: 'GOLD' },
      { master: 'xauusd', slave: 'XAUUSD.M' },
    ])).toEqual({ XAUUSD: 'XAUUSD.M' })
  })

  it('round-trips a record through rows unchanged', () => {
    const record = { EURUSD: 'EURUSD.R', XAUUSD: 'GOLD', US30: 'US30.M' }
    expect(symbolMapRowsToRecord(symbolMapRecordToRows(record))).toEqual(record)
  })
})

describe('initialCommittedSymbolMap', () => {
  it('seeds every complete row, normalised, keyed by row id', () => {
    const committed = initialCommittedSymbolMap([{ id: 'r1', master: 'xauusd', slave: ' gold ' }])
    expect(committed.get('r1')).toEqual({ master: 'XAUUSD', slave: 'GOLD' })
  })

  it('skips incomplete rows', () => {
    const committed = initialCommittedSymbolMap([{ id: 'r1', master: 'XAUUSD', slave: '' }])
    expect(committed.size).toBe(0)
  })
})

describe('buildSymbolMapRecord', () => {
  const loaded = initialCommittedSymbolMap([{ id: 'r1', master: 'XAUUSD', slave: 'GOLD' }])

  it('retains the mapping when a freshly loaded row has a cleared field', () => {
    expect(buildSymbolMapRecord([{ id: 'r1', master: 'XAUUSD', slave: '' }], loaded)).toEqual({ XAUUSD: 'GOLD' })
  })

  it('retains the mapping when the master side is cleared for a retype', () => {
    expect(buildSymbolMapRecord([{ id: 'r1', master: '', slave: 'GOLD' }], loaded)).toEqual({ XAUUSD: 'GOLD' })
  })

  it('trusts a nonempty edit immediately — a partially retyped master replaces the entry', () => {
    expect(buildSymbolMapRecord([{ id: 'r1', master: 'XA', slave: 'GOLD' }], loaded)).toEqual({ XA: 'GOLD' })
  })

  it('commits a completed edit over the retained entry', () => {
    expect(buildSymbolMapRecord([{ id: 'r1', master: 'xauusd', slave: 'xauusd.m' }], loaded)).toEqual({
      XAUUSD: 'XAUUSD.M',
    })
  })

  it('drops a removed row instead of resurrecting it', () => {
    expect(buildSymbolMapRecord([], loaded)).toEqual({})
  })

  it('never emits an entry for a row that was never committed', () => {
    expect(buildSymbolMapRecord([{ id: 'r2', master: 'US30', slave: '' }], loaded)).toEqual({})
  })

  it('normalises retained entries even when the map holds raw text', () => {
    const raw = new Map([['r1', { master: ' xauusd ', slave: 'gold' }]])
    expect(buildSymbolMapRecord([{ id: 'r1', master: 'XAUUSD', slave: '' }], raw)).toEqual({ XAUUSD: 'GOLD' })
  })
})

describe('symbolMapsEqual', () => {
  it('is true for same keys and values regardless of order', () => {
    expect(symbolMapsEqual({ A: '1', B: '2' }, { B: '2', A: '1' })).toBe(true)
  })

  it('is false for differing keys or values', () => {
    expect(symbolMapsEqual({ A: '1' }, { A: '2' })).toBe(false)
    expect(symbolMapsEqual({ A: '1' }, { A: '1', B: '2' })).toBe(false)
    expect(symbolMapsEqual({}, { A: '1' })).toBe(false)
  })
})

describe('isCompleteSymbolMapRow', () => {
  it('treats whitespace-only sides as incomplete', () => {
    expect(isCompleteSymbolMapRow({ master: 'XAUUSD', slave: '  ' })).toBe(false)
    expect(isCompleteSymbolMapRow({ master: 'XAUUSD', slave: 'GOLD' })).toBe(true)
  })
})

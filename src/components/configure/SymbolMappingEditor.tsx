import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '../ui/Button'
import {
  buildSymbolMapRecord,
  initialCommittedSymbolMap,
  isCompleteSymbolMapRow,
  normalizeSymbol,
  symbolMapRecordToRows,
  symbolMapsEqual,
  type IdentifiedSymbolMapRow,
} from '../../lib/symbolMap'

export type SymbolMappingLabels = {
  title: string
  hint: string
  master: string
  slave: string
  add: string
  remove: string
  empty: string
}

type EditorRow = IdentifiedSymbolMapRow

type PendingRecord = {
  record: Record<string, string>
  complete: EditorRow[]
}

const INPUT_BASE =
  'w-full rounded-lg border px-3 py-2 text-sm uppercase text-neutral-900 ' +
  'focus:outline-none focus:ring-2 focus:ring-teal-500/25 ' +
  'dark:bg-neutral-900 dark:text-neutral-50'

const INPUT_NEUTRAL = 'border-neutral-200 focus:border-green-400 dark:border-neutral-700'
const INPUT_DUPLICATE = 'border-amber-400 focus:border-amber-400 dark:border-amber-500/60'

const REMOVE_CLASS =
  'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-neutral-400 hover:bg-neutral-100 ' +
  'hover:text-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40 ' +
  'dark:hover:bg-neutral-800 dark:hover:text-red-400'

const DEBOUNCE_MS = 400

function makeRowId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `map-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function SymbolMappingEditor({
  value,
  labels,
  onChange,
}: {
  value: Record<string, string>
  labels: SymbolMappingLabels
  onChange: (next: Record<string, string>) => void
}) {
  const [rows, setRows] = useState<EditorRow[]>(() =>
    symbolMapRecordToRows(value).map(row => ({ id: makeRowId(), ...row })),
  )
  const [pending, setPending] = useState<PendingRecord | null>(null)

  const onChangeRef = useRef(onChange)
  const valueRef = useRef(value)
  const pendingRef = useRef<PendingRecord | null>(null)
  const committedRef = useRef<Map<string, { master: string; slave: string }>>(new Map())
  const rowsRef = useRef<EditorRow[]>(rows)

  useEffect(() => {
    onChangeRef.current = onChange
  })
  useEffect(() => {
    valueRef.current = value
  })
  useEffect(() => {
    rowsRef.current = rows
  }, [rows])
  useEffect(() => {
    pendingRef.current = pending
  }, [pending])

  useLayoutEffect(() => {
    if (committedRef.current.size > 0) return
    for (const [id, entry] of initialCommittedSymbolMap(rowsRef.current)) {
      committedRef.current.set(id, entry)
    }
  }, [])

  useEffect(() => {
    if (!pending) return
    const timer = setTimeout(() => {
      if (!symbolMapsEqual(pending.record, valueRef.current)) {
        onChangeRef.current(pending.record)
      }
      for (const row of pending.complete) {
        committedRef.current.set(row.id, { master: normalizeSymbol(row.master), slave: normalizeSymbol(row.slave) })
      }
      pendingRef.current = null
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [pending])

  useEffect(() => {
    const committed = committedRef.current
    return () => {
      const last = pendingRef.current
      if (last && !symbolMapsEqual(last.record, valueRef.current)) {
        onChangeRef.current(last.record)
        for (const row of last.complete) {
          committed.set(row.id, { master: normalizeSymbol(row.master), slave: normalizeSymbol(row.slave) })
        }
      }
    }
  }, [])

  const commit = (next: EditorRow[]) => {
    const nextIds = new Set(next.map(row => row.id))
    for (const id of committedRef.current.keys()) {
      if (!nextIds.has(id)) committedRef.current.delete(id)
    }
    const complete = next.filter(isCompleteSymbolMapRow)
    rowsRef.current = next
    setRows(next)
    setPending({ record: buildSymbolMapRecord(next, committedRef.current), complete })
  }

  const updateRow = (id: string, field: keyof EditorRow, text: string) => {
    commit(rowsRef.current.map(row => (row.id === id ? { ...row, [field]: text } : row)))
  }

  const duplicateMasters = new Set(
    rows
      .map(row => normalizeSymbol(row.master))
      .filter(master => master !== '')
      .filter((master, index, all) => all.indexOf(master) !== index),
  )

  return (
    <section aria-label={labels.title}>
      <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{labels.title}</p>
      <p className="mt-0.5 text-xs leading-5 text-neutral-900 dark:text-neutral-50">{labels.hint}</p>

      {rows.length > 0 ? (
        <div className="mt-3 grid grid-cols-[1fr_1fr_auto] gap-2" aria-hidden>
          <span className="text-[10px] font-semibold uppercase tracking-widest text-neutral-500 dark:text-neutral-400">{labels.master}</span>
          <span className="text-[10px] font-semibold uppercase tracking-widest text-neutral-500 dark:text-neutral-400">{labels.slave}</span>
          <span className="w-10" />
        </div>
      ) : null}

      <div className="mt-1 space-y-2">
        {rows.map((row, index) => {
          const isDuplicate = normalizeSymbol(row.master) !== '' && duplicateMasters.has(normalizeSymbol(row.master))
          const number = index + 1
          return (
            <div key={row.id} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
              <input
                type="text"
                className={`${INPUT_BASE} ${isDuplicate ? INPUT_DUPLICATE : INPUT_NEUTRAL}`}
                value={row.master}
                placeholder="XAUUSD"
                aria-label={`${labels.master} ${number}`}
                autoComplete="off"
                spellCheck={false}
                onChange={event => updateRow(row.id, 'master', event.target.value)}
              />
              <input
                type="text"
                className={`${INPUT_BASE} ${INPUT_NEUTRAL}`}
                value={row.slave}
                placeholder="GOLD"
                aria-label={`${labels.slave} ${number}`}
                autoComplete="off"
                spellCheck={false}
                onChange={event => updateRow(row.id, 'slave', event.target.value)}
              />
              <button
                type="button"
                className={REMOVE_CLASS}
                aria-label={row.master ? `${labels.remove} ${number}: ${row.master}` : `${labels.remove} ${number}`}
                title={labels.remove}
                onClick={() => commit(rowsRef.current.filter(item => item.id !== row.id))}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
            </div>
          )
        })}
      </div>

      {rows.length === 0 ? (
        <p className="mt-3 text-xs leading-5 text-neutral-500 dark:text-neutral-400">{labels.empty}</p>
      ) : null}

      <div className="mt-3">
        <Button
          type="button"
          variant="secondary"
          aria-label={labels.add}
          onClick={() => commit([...rowsRef.current, { id: makeRowId(), master: '', slave: '' }])}
        >
          <Plus className="mr-1.5 h-4 w-4" aria-hidden />
          {labels.add}
        </Button>
      </div>
    </section>
  )
}

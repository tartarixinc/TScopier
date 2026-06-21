import { useEffect, useState } from 'react'
import { Loader2, Plus, X } from 'lucide-react'
import { useT } from '../../context/LocaleContext'
import { backtestApi } from '../../lib/backtestApi'
import type { BacktestRunRow, BacktestTradeRow } from '../../lib/backtestTypes'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'

interface TradeDraft {
  direction: 'buy' | 'sell'
  entryPrice: string
  sl: string
  tpLevels: string[]
}

interface BacktestEditSignalModalProps {
  trade: BacktestTradeRow | null
  onClose: () => void
  onTradeUpdated: (trade: BacktestTradeRow, run: BacktestRunRow | null) => void
}

function tradeToDraft(trade: BacktestTradeRow): TradeDraft {
  return {
    direction: trade.direction === 'sell' ? 'sell' : 'buy',
    entryPrice: trade.entry_price > 0 ? String(trade.entry_price) : '',
    sl: trade.sl != null ? String(trade.sl) : '',
    tpLevels: trade.tp_levels.length > 0
      ? trade.tp_levels.map(String)
      : [''],
  }
}

function parseDraft(draft: TradeDraft): {
  entry_price: number
  sl: number | null
  tp_levels: number[]
} | null {
  const entry_price = Number(draft.entryPrice)
  const sl = draft.sl.trim() === '' ? null : Number(draft.sl)
  const tp_levels = draft.tpLevels
    .map(s => Number(s.trim()))
    .filter(n => Number.isFinite(n) && n > 0)

  if (!(entry_price > 0)) return null
  if (sl !== null && !(sl > 0)) return null
  if (sl === null && tp_levels.length === 0) return null
  return { entry_price, sl, tp_levels }
}

export function BacktestEditSignalModal({
  trade,
  onClose,
  onTradeUpdated,
}: BacktestEditSignalModalProps) {
  const t = useT()
  const bt = t.backtest
  const [draft, setDraft] = useState<TradeDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState('')

  useEffect(() => {
    if (!trade) {
      setDraft(null)
      setFormError('')
      return
    }
    setDraft(tradeToDraft(trade))
    setFormError('')
  }, [trade])

  useEffect(() => {
    if (!trade) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [trade, onClose, busy])

  if (!trade || !draft) return null

  const isDirty =
    draft.direction !== (trade.direction === 'sell' ? 'sell' : 'buy')
    || draft.entryPrice !== (trade.entry_price > 0 ? String(trade.entry_price) : '')
    || draft.sl !== (trade.sl != null ? String(trade.sl) : '')
    || JSON.stringify(draft.tpLevels.filter(Boolean)) !== JSON.stringify(trade.tp_levels.map(String))

  const handleRerun = async () => {
    const parsed = parseDraft(draft)
    if (!parsed) {
      setFormError(bt.invalidLevels)
      return
    }
    setFormError('')
    setBusy(true)
    try {
      const { trade: updated, run } = await backtestApi.resimulateTrade({
        trade_id: trade.id,
        direction: draft.direction,
        ...parsed,
      })
      onTradeUpdated(updated, run)
      onClose()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : bt.rerunFailed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="backtest-edit-signal-title"
    >
      <button
        type="button"
        className="absolute inset-0 bg-neutral-950/55"
        aria-label={bt.close}
        onClick={onClose}
        disabled={busy}
      />
      <div className="relative w-full sm:max-w-lg max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-5 py-4 border-b border-neutral-100 dark:border-neutral-800 bg-white dark:bg-neutral-900">
          <h2 id="backtest-edit-signal-title" className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">
            {bt.editSignal}
          </h2>
          <button
            type="button"
            className="p-2 rounded-lg text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors disabled:opacity-40"
            aria-label={bt.close}
            onClick={onClose}
            disabled={busy}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="block col-span-2 sm:col-span-1">
              <span className="text-xs font-medium text-neutral-500">{bt.direction}</span>
              <select
                value={draft.direction}
                disabled={busy}
                onChange={e => setDraft(d => d && ({
                  ...d,
                  direction: e.target.value === 'sell' ? 'sell' : 'buy',
                }))}
                className="mt-1.5 w-full rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2.5 text-sm disabled:opacity-50"
              >
                <option value="buy">{bt.buy}</option>
                <option value="sell">{bt.sell}</option>
              </select>
            </label>
            <Input
              label={bt.entry}
              type="number"
              step="any"
              min="0"
              disabled={busy}
              value={draft.entryPrice}
              onChange={e => setDraft(d => d && ({ ...d, entryPrice: e.target.value }))}
            />
            <Input
              label={bt.stopLoss}
              type="number"
              step="any"
              min="0"
              disabled={busy}
              placeholder="—"
              value={draft.sl}
              onChange={e => setDraft(d => d && ({ ...d, sl: e.target.value }))}
            />
          </div>
          <div>
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-xs font-medium text-neutral-500">{bt.takeProfits}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => setDraft(d => d && ({ ...d, tpLevels: [...d.tpLevels, ''] }))}
                className="inline-flex items-center gap-1 text-xs font-medium text-teal-600 hover:text-teal-700 dark:text-teal-400"
              >
                <Plus className="w-3.5 h-3.5" />
                {bt.addTp}
              </button>
            </div>
            <div className="space-y-2">
              {draft.tpLevels.map((tp, idx) => (
                <div key={idx} className="flex gap-2">
                  <input
                    type="number"
                    step="any"
                    min="0"
                    disabled={busy}
                    placeholder={`TP${idx + 1}`}
                    value={tp}
                    onChange={e => setDraft(d => {
                      if (!d) return d
                      const next = [...d.tpLevels]
                      next[idx] = e.target.value
                      return { ...d, tpLevels: next }
                    })}
                    className="flex-1 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2 text-sm disabled:opacity-50"
                  />
                  {draft.tpLevels.length > 1 ? (
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={bt.removeTp}
                      onClick={() => setDraft(d => {
                        if (!d) return d
                        const next = d.tpLevels.filter((_, i) => i !== idx)
                        return { ...d, tpLevels: next.length ? next : [''] }
                      })}
                      className="shrink-0 rounded-xl border border-neutral-200 dark:border-neutral-700 px-3 text-neutral-400 hover:text-error-600"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
          {formError ? (
            <p className="text-xs text-error-600 dark:text-error-400">{formError}</p>
          ) : null}
          <Button
            className="w-full"
            disabled={busy}
            onClick={() => { void handleRerun() }}
          >
            {busy ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                {bt.rerunning}
              </>
            ) : (
              bt.rerunCheck
            )}
          </Button>
          {isDirty && !busy ? (
            <p className="text-[11px] text-neutral-500 text-center">{bt.unsavedHint}</p>
          ) : null}
        </div>
      </div>
    </div>
  )
}

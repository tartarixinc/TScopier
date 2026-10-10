import { useEffect, useState } from 'react'
import { CheckCircle2, X } from 'lucide-react'
import clsx from 'clsx'
import { supabase } from '../../lib/supabase'
import { useT } from '../../context/LocaleContext'
import { Button } from '../ui/Button'
import type { MtTrade } from '../../lib/fxsocketBroker'

interface ReportTradeModalProps {
  trade: MtTrade
  userId: string | undefined
  onClose: () => void
}

const REPORT_CATEGORIES = [
  'wrong_entry',
  'wrong_sl',
  'wrong_tp',
  'wrong_direction',
  'wrong_lots',
  'not_executed',
  'other',
] as const

type ReportCategory = (typeof REPORT_CATEGORIES)[number]

export function ReportTradeModal({ trade, userId, onClose }: ReportTradeModalProps) {
  const t = useT()
  const tr = t.trades
  const [category, setCategory] = useState<ReportCategory | null>(null)
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [onClose])

  const categoryLabel = (key: ReportCategory): string => {
    switch (key) {
      case 'wrong_entry':
        return tr.catWrongEntry
      case 'wrong_sl':
        return tr.catWrongSl
      case 'wrong_tp':
        return tr.catWrongTp
      case 'wrong_direction':
        return tr.catWrongDirection
      case 'wrong_lots':
        return tr.catWrongLots
      case 'not_executed':
        return tr.catNotExecuted
      case 'other':
        return tr.catOther
    }
  }

  const canSubmit = !submitting && Boolean(category) && reason.trim().length > 0

  const handleSubmit = async () => {
    if (!category || !userId) return
    setSubmitting(true)
    setError('')
    try {
      const { error: insertError } = await supabase.from('trade_reports').insert({
        user_id: userId,
        symbol: trade.symbol || '',
        direction: trade.direction || '',
        ticket: trade.ticket != null ? String(trade.ticket) : null,
        broker_label: trade.broker_label || null,
        entry_price: trade.entry_price,
        sl: trade.sl,
        tp: trade.tp,
        lot_size: trade.lot_size,
        category,
        reason: reason.trim(),
        status: 'open',
      })
      if (insertError) throw insertError
      setDone(true)
    } catch (e) {
      console.error('[reportTrade] insert failed', e)
      setError(tr.reportError)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6" role="dialog" aria-modal="true">
      <button type="button" className="absolute inset-0 bg-neutral-950/55" aria-label={tr.close} onClick={onClose} />
      <div className="relative w-full sm:max-w-md max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-neutral-200/65 dark:border-neutral-800/55 bg-white dark:bg-neutral-900 shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-5 py-4 border-b border-neutral-100 dark:border-neutral-800 bg-white dark:bg-neutral-900">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50 truncate">{tr.reportTitle}</h2>
            <p className="text-xs text-neutral-400 tabular-nums truncate">
              {trade.symbol || '—'} · #{trade.ticket}
            </p>
          </div>
          <button
            type="button"
            className="p-2 rounded-lg text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            aria-label={tr.close}
            onClick={onClose}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {done ? (
            <div className="flex flex-col items-center text-center py-8 space-y-3">
              <CheckCircle2 className="w-12 h-12 text-success-500" />
              <p className="text-base font-semibold text-neutral-900 dark:text-neutral-50">{tr.reportSuccess}</p>
              <Button variant="secondary" size="md" onClick={onClose}>
                {tr.close}
              </Button>
            </div>
          ) : (
            <>
              <p className="text-sm text-neutral-500 dark:text-neutral-400">{tr.reportSubtitle}</p>

              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-2">{tr.reportCategory}</p>
                <div className="flex flex-wrap gap-1.5">
                  {REPORT_CATEGORIES.map(key => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setCategory(key)}
                      className={clsx(
                        'text-xs font-medium px-3 py-1.5 rounded-full border transition-colors',
                        category === key
                          ? 'border-teal-500 bg-teal-50 text-teal-700 dark:bg-teal-950/40 dark:text-teal-300 dark:border-teal-700'
                          : 'border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800',
                      )}
                    >
                      {categoryLabel(key)}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-2">{tr.reportReason}</p>
                <textarea
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  placeholder={tr.reportReasonPlaceholder}
                  rows={4}
                  className="w-full text-sm bg-neutral-50 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg px-3 py-2.5 text-neutral-900 dark:text-neutral-50 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-teal-500/60 resize-none"
                />
              </div>

              {error && <p className="text-sm text-error-600 dark:text-error-400">{error}</p>}

              <div className="flex items-center justify-end gap-2 pt-1">
                <Button variant="ghost" size="md" onClick={onClose}>
                  {tr.cancel}
                </Button>
                <Button variant="primary" size="md" loading={submitting} disabled={!canSubmit} onClick={handleSubmit}>
                  {tr.reportSubmit}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

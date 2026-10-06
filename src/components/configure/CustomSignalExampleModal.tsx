import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, Plus, Sparkles, X } from 'lucide-react'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Alert } from '../ui/Alert'
import type { ConfigureModalTranslations } from '../../i18n/locales/configureModal/types'
import {
  formatTradeIntentSummary,
  parseCustomSignalExample,
  saveChannelSignalExample,
  type ChannelSignalExampleRow,
} from '../../lib/channelSignalExamples'
import {
  emptySignalExampleFormDraft,
  formDraftFromIntent,
  intentFromFormDraft,
  type SignalExampleFormDraft,
} from '../../lib/tradeIntent'

type Labels = ConfigureModalTranslations['aiTraining']

type Props = {
  open: boolean
  channelId: string
  userId: string
  labels: Labels
  initial?: ChannelSignalExampleRow | null
  onClose: () => void
  onSaved: (row: ChannelSignalExampleRow) => void
}

function rejectedMessage(reason: string | null | undefined, labels: Labels): string {
  switch (reason) {
    case 'commentary_not_trade_signal':
      return labels.exampleRejectedCommentary
    case 'empty_message':
      return labels.exampleRejectedEmpty
    case 'entry_missing_side':
      return labels.exampleRejectedMissingSide
    case 'entry_missing_prices':
      return labels.exampleRejectedMissingPrices
    default:
      return labels.exampleRejectedGeneric
  }
}

export function CustomSignalExampleModal({
  open,
  channelId,
  userId,
  labels,
  initial,
  onClose,
  onSaved,
}: Props) {
  const [draft, setDraft] = useState<SignalExampleFormDraft>(emptySignalExampleFormDraft())
  const [analyzed, setAnalyzed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [error, setError] = useState('')
  const [summary, setSummary] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    if (initial) {
      setDraft(formDraftFromIntent(initial.raw_message, initial.label, initial.intent))
      setAnalyzed(true)
      setSummary(formatTradeIntentSummary(initial.intent))
    } else {
      setDraft(emptySignalExampleFormDraft())
      setAnalyzed(false)
      setSummary(null)
    }
    setError('')
    setBusy(false)
    setAnalyzing(false)
  }, [open, initial])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy && !analyzing) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, busy, analyzing, onClose])

  if (!open) return null

  const handleAnalyze = async () => {
    const raw = draft.rawMessage.trim()
    if (!raw) {
      setError(labels.exampleRejectedEmpty)
      return
    }
    setError('')
    setAnalyzing(true)
    try {
      const hint = draft.signalType === 'auto' ? null : draft.signalType
      const result = await parseCustomSignalExample(channelId, raw, hint)
      if (!result.ok) {
        setError(rejectedMessage(result.rejected_reason, labels))
        setAnalyzed(false)
        return
      }
      const next = formDraftFromIntent(raw, result.label, result.intent)
      // Keep user's explicit type if they chose one.
      if (draft.signalType !== 'auto') next.signalType = draft.signalType
      setDraft(next)
      setSummary(formatTradeIntentSummary(result.intent))
      setAnalyzed(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : labels.exampleRejectedGeneric)
      setAnalyzed(false)
    } finally {
      setAnalyzing(false)
    }
  }

  const handleSave = async () => {
    setError('')
    const mapped = intentFromFormDraft(draft)
    if (mapped.error) {
      setError(rejectedMessage(mapped.error, labels))
      return
    }
    setBusy(true)
    try {
      const row = await saveChannelSignalExample({
        channelId,
        userId,
        rawMessage: draft.rawMessage,
        label: mapped.label,
        intent: mapped.intent,
        sortOrder: initial?.sort_order ?? 0,
        existingId: initial?.id ?? null,
      })
      onSaved(row)
      onClose()
    } catch (err) {
      const msg = err instanceof Error ? err.message : labels.exampleRejectedGeneric
      setError(rejectedMessage(msg, labels) === labels.exampleRejectedGeneric && msg !== 'commentary_not_trade_signal'
        ? msg
        : rejectedMessage(msg, labels))
    } finally {
      setBusy(false)
    }
  }

  const title = initial ? labels.customExampleEditTitle : labels.customExampleTitle
  const showFields = analyzed || Boolean(initial)

  return createPortal(
    <div
      className="fixed inset-0 z-[110] flex items-end sm:items-center justify-center p-0 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="custom-signal-example-title"
    >
      <button
        type="button"
        className="absolute inset-0 bg-neutral-950/55"
        aria-label={labels.cancel}
        onClick={onClose}
        disabled={busy || analyzing}
      />
      <div className="relative w-full sm:max-w-lg max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-neutral-200/65 dark:border-neutral-800/55 bg-white dark:bg-neutral-900 shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-5 py-4 border-b border-neutral-100 dark:border-neutral-800 bg-white dark:bg-neutral-900">
          <h2 id="custom-signal-example-title" className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">
            {title}
          </h2>
          <button
            type="button"
            className="p-2 rounded-lg text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors disabled:opacity-40"
            aria-label={labels.cancel}
            onClick={onClose}
            disabled={busy || analyzing}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {error ? <Alert variant="error">{error}</Alert> : null}

          <label className="block">
            <span className="text-xs font-medium text-neutral-500">{labels.pasteSignalPlaceholder}</span>
            <textarea
              value={draft.rawMessage}
              disabled={busy || analyzing}
              rows={5}
              placeholder={labels.pasteSignalPlaceholder}
              onChange={e => {
                setDraft(d => ({ ...d, rawMessage: e.target.value }))
                setAnalyzed(false)
              }}
              className="mt-1.5 w-full rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2.5 text-sm disabled:opacity-50 resize-y min-h-[7rem]"
            />
          </label>

          <label className="block">
            <span className="text-xs font-medium text-neutral-500">{labels.signalTypeLabel}</span>
            <select
              value={draft.signalType}
              disabled={busy || analyzing}
              onChange={e => {
                const v = e.target.value
                setDraft(d => ({
                  ...d,
                  signalType: v === 'entry' || v === 'update' ? v : 'auto',
                }))
              }}
              className="mt-1.5 w-full rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2.5 text-sm disabled:opacity-50"
            >
              <option value="auto">{labels.signalTypeAuto}</option>
              <option value="entry">{labels.signalTypeEntry}</option>
              <option value="update">{labels.signalTypeUpdate}</option>
            </select>
          </label>

          <Button
            type="button"
            variant="secondary"
            disabled={busy || analyzing || !draft.rawMessage.trim()}
            loading={analyzing}
            onClick={() => void handleAnalyze()}
            className="w-full min-h-[44px]"
          >
            {analyzing ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                {labels.analyzingExample}
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" aria-hidden />
                {labels.analyzeExample}
              </>
            )}
          </Button>

          {showFields ? (
            <div className="space-y-3 rounded-xl border border-neutral-100 dark:border-neutral-800 bg-neutral-50/70 dark:bg-neutral-800/30 p-3">
              {summary ? (
                <p className="text-xs font-medium text-neutral-600 dark:text-neutral-300">{summary}</p>
              ) : null}

              {(draft.signalType === 'entry' || draft.signalType === 'auto') && (
                <label className="block">
                  <span className="text-xs font-medium text-neutral-500">{labels.sideLabel}</span>
                  <select
                    value={draft.side}
                    disabled={busy}
                    onChange={e => {
                      const v = e.target.value
                      setDraft(d => ({
                        ...d,
                        side: v === 'BUY' || v === 'SELL' ? v : 'NONE',
                        signalType: d.signalType === 'auto' && (v === 'BUY' || v === 'SELL') ? 'entry' : d.signalType,
                      }))
                    }}
                    className="mt-1.5 w-full rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2.5 text-sm disabled:opacity-50"
                  >
                    <option value="NONE">{labels.sideNone}</option>
                    <option value="BUY">{labels.sideBuy}</option>
                    <option value="SELL">{labels.sideSell}</option>
                  </select>
                </label>
              )}

              {(draft.signalType === 'update') && (
                <label className="block">
                  <span className="text-xs font-medium text-neutral-500">{labels.updateKindLabel}</span>
                  <select
                    value={draft.updateKind}
                    disabled={busy}
                    onChange={e => {
                      const v = e.target.value
                      setDraft(d => ({
                        ...d,
                        updateKind:
                          v === 'close' || v === 'breakeven' || v === 'partial_close' ? v : 'modify',
                      }))
                    }}
                    className="mt-1.5 w-full rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-2.5 text-sm disabled:opacity-50"
                  >
                    <option value="modify">{labels.updateKindModify}</option>
                    <option value="close">{labels.updateKindClose}</option>
                    <option value="breakeven">{labels.updateKindBreakeven}</option>
                    <option value="partial_close">{labels.updateKindPartial}</option>
                  </select>
                </label>
              )}

              <Input
                label={labels.fieldSymbol}
                disabled={busy}
                value={draft.symbol}
                onChange={e => setDraft(d => ({ ...d, symbol: e.target.value }))}
              />

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Input
                  label={labels.fieldEntry}
                  type="number"
                  step="any"
                  min="0"
                  disabled={busy}
                  value={draft.entryPrice}
                  onChange={e => setDraft(d => ({ ...d, entryPrice: e.target.value, entryZoneLow: '', entryZoneHigh: '' }))}
                />
                <Input
                  label={labels.fieldSl}
                  type="number"
                  step="any"
                  min="0"
                  disabled={busy}
                  value={draft.sl}
                  onChange={e => setDraft(d => ({ ...d, sl: e.target.value }))}
                />
                <Input
                  label={labels.fieldEntryZoneLow}
                  type="number"
                  step="any"
                  min="0"
                  disabled={busy}
                  value={draft.entryZoneLow}
                  onChange={e => setDraft(d => ({ ...d, entryZoneLow: e.target.value, entryPrice: '' }))}
                />
                <Input
                  label={labels.fieldEntryZoneHigh}
                  type="number"
                  step="any"
                  min="0"
                  disabled={busy}
                  value={draft.entryZoneHigh}
                  onChange={e => setDraft(d => ({ ...d, entryZoneHigh: e.target.value, entryPrice: '' }))}
                />
              </div>

              <div>
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-xs font-medium text-neutral-500">{labels.fieldTp}</span>
                  <button
                    type="button"
                    disabled={busy || draft.tpLevels.length >= 5}
                    onClick={() => setDraft(d => ({ ...d, tpLevels: [...d.tpLevels, ''] }))}
                    className="inline-flex items-center gap-1 text-xs font-medium text-teal-600 hover:text-teal-700 dark:text-teal-400 disabled:opacity-40"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    {labels.addTp}
                  </button>
                </div>
                <div className="space-y-2">
                  {draft.tpLevels.map((tp, idx) => (
                    <Input
                      key={`tp-${idx}`}
                      label={`${labels.fieldTp} ${idx + 1}`}
                      type="number"
                      step="any"
                      min="0"
                      disabled={busy}
                      value={tp}
                      onChange={e => {
                        const value = e.target.value
                        setDraft(d => ({
                          ...d,
                          tpLevels: d.tpLevels.map((t, i) => (i === idx ? value : t)),
                        }))
                      }}
                    />
                  ))}
                </div>
              </div>
            </div>
          ) : null}
        </div>

        <div className="sticky bottom-0 flex items-center justify-end gap-2 px-5 py-4 border-t border-neutral-100 dark:border-neutral-800 bg-white dark:bg-neutral-900">
          <Button type="button" variant="ghost" disabled={busy || analyzing} onClick={onClose}>
            {labels.cancel}
          </Button>
          <Button
            type="button"
            disabled={!showFields || busy || analyzing}
            loading={busy}
            onClick={() => void handleSave()}
          >
            {labels.saveExample}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

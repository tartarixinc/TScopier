import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, Loader2, Plus, X } from 'lucide-react'
import { useT } from '../../context/LocaleContext'
import { interpolate } from '../../i18n/interpolate'
import {
  effectiveDisplayParsedData,
  foldMgmtUpdatesIntoParsed,
  validateOverrideLevels,
  type SignalBatchRow,
  type SignalDisplayContext,
} from '../../lib/signalOverride'
import { symbolForCopierLog } from '../../lib/copierLogDisplay'
import { signalOverrideApi } from '../../lib/signalOverrideApi'
import { forceCloseTradesApi } from '../../lib/forceCloseTradesApi'
import type { Signal } from '../../types/database'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'

export type OverrideDraft = {
  sl: string
  tpLevels: string[]
}

export type EditSignalOverrideSnapshot = {
  signalId: string
  /** Trade symbol resolved for this signal (copier-log rules); '—' when unknown. */
  symbol: string
  initialDraft: OverrideDraft
  original: { sl: string; tp: string }
  current: { sl: string; tp: string }
}

/** Result summary stays on screen this long before the modal closes itself. */
const RESULT_AUTO_CLOSE_SECONDS = 10

type ModalMode = 'edit' | 'confirmClose' | 'result'

type ModalResult = {
  kind: 'updated' | 'closed'
  text: string
  sub?: string
  /** Partial success (some brokers/legs failed) — render amber, not green. */
  partial?: boolean
}

function overrideToDraft(
  signal: Signal,
  displayContext: SignalDisplayContext,
  absorbedEntryUpdates: ReadonlyArray<SignalBatchRow> = [],
): OverrideDraft {
  const effective = effectiveDisplayParsedData(signal, displayContext, absorbedEntryUpdates)
  const sl = effective.sl
  const tp = Array.isArray(effective.tp) ? effective.tp : []
  return {
    sl: typeof sl === 'number' && Number.isFinite(sl) ? String(sl) : '',
    tpLevels: tp.length > 0
      ? tp.filter(v => typeof v === 'number' && Number.isFinite(v)).map(String)
      : [''],
  }
}

function channelFoldedSummary(
  signal: Signal,
  displayContext: SignalDisplayContext,
  absorbedEntryUpdates: ReadonlyArray<SignalBatchRow> = [],
): { sl: string; tp: string } {
  const parsed = displayContext.batchSignals.length
    ? foldMgmtUpdatesIntoParsed(signal, displayContext.batchSignals, displayContext, absorbedEntryUpdates)
    : ((signal.parsed_data ?? {}) as Record<string, unknown>)
  const sl = typeof parsed.sl === 'number' && parsed.sl > 0 ? String(parsed.sl) : '—'
  const tpArr = Array.isArray(parsed.tp)
    ? parsed.tp.filter(v => typeof v === 'number' && (v as number) > 0).map(String)
    : []
  return { sl, tp: tpArr.length ? tpArr.join(', ') : '—' }
}

function formatEffectiveSummary(
  signal: Signal,
  displayContext: SignalDisplayContext,
  absorbedEntryUpdates: ReadonlyArray<SignalBatchRow> = [],
): { sl: string; tp: string } {
  const effective = effectiveDisplayParsedData(signal, displayContext, absorbedEntryUpdates)
  const sl = typeof effective.sl === 'number' ? String(effective.sl) : '—'
  const tp = Array.isArray(effective.tp)
    ? effective.tp.filter(v => typeof v === 'number').map(String).join(', ') || '—'
    : '—'
  return { sl, tp }
}

/** Capture SL/TP display + form draft once when the modal opens (avoids re-folding 500 signals on each keystroke). */
export function buildEditSignalOverrideSnapshot(
  signal: Signal,
  displayContext: SignalDisplayContext,
  absorbedEntryUpdates: ReadonlyArray<SignalBatchRow> = [],
): EditSignalOverrideSnapshot {
  const absorbed = absorbedEntryUpdates.length ? [...absorbedEntryUpdates] : []
  return {
    signalId: signal.id,
    symbol: symbolForCopierLog(
      signal,
      displayContext.symbolContext ?? { lookup: new Map(), replyParentBySignalId: new Map() },
      displayContext.batchSignals as SignalBatchRow[],
    ),
    initialDraft: overrideToDraft(signal, displayContext, absorbed),
    original: channelFoldedSummary(signal, displayContext, absorbed),
    current: formatEffectiveSummary(signal, displayContext, absorbed),
  }
}

function normalizeTpLevels(levels: string[]): string[] {
  return levels.map(s => s.trim()).filter(s => s !== '')
}

function draftsEqual(a: OverrideDraft, b: OverrideDraft): boolean {
  if (a.sl.trim() !== b.sl.trim()) return false
  const tpA = normalizeTpLevels(a.tpLevels)
  const tpB = normalizeTpLevels(b.tpLevels)
  if (tpA.length !== tpB.length) return false
  return tpA.every((value, index) => value === tpB[index])
}

function parseDraft(draft: OverrideDraft): { sl: number | null; tp_levels: number[] } | null {
  const sl = draft.sl.trim() === '' ? null : Number(draft.sl)
  const tp_levels = draft.tpLevels
    .map(s => Number(s.trim()))
    .filter(n => Number.isFinite(n) && n > 0)
  if (!validateOverrideLevels({ sl, tpLevels: tp_levels })) return null
  return { sl, tp_levels }
}

/** Map a close result that did nothing to a specific message (stays on the confirm view). */
function closeResultError(
  sh: {
    closeNoOpenTrades: string
    closeNotConnected: string
    closeRetry: string
    closeFailed: string
    closeSignalGone: string
  },
  res: { reason?: string },
): string {
  switch (res.reason) {
    case 'no_open_trades': return sh.closeNoOpenTrades
    case 'broker_not_connected': return sh.closeNotConnected
    case 'close_failed': return sh.closeFailed
    case 'signal_not_found': return sh.closeSignalGone
    case 'wrong_shard':
    case 'missing_ids': return sh.closeRetry
    default: return sh.closeFailed
  }
}

type EditSignalOverrideModalProps = EditSignalOverrideSnapshot & {
  onClose: () => void
  onSaved: (result: {
    appliedLegs: number
    open: boolean
    brokersUpdated?: number
    brokersTotal?: number
  }) => void
  onClosed: (result: { closed: number; failed: number; virtualDeleted: number }) => void
}

export function EditSignalOverrideModal({
  signalId,
  symbol,
  initialDraft,
  original,
  current,
  onClose,
  onSaved,
  onClosed,
}: EditSignalOverrideModalProps) {
  const t = useT()
  const sh = t.signalHistoryPage
  const symbolPrefix = symbol && symbol !== '—' ? `${symbol} · ` : ''
  const [draft, setDraft] = useState(initialDraft)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState('')
  const [mode, setMode] = useState<ModalMode>('edit')
  const [result, setResult] = useState<ModalResult | null>(null)
  const [countdown, setCountdown] = useState(RESULT_AUTO_CLOSE_SECONDS)
  const [closingTrade, setClosingTrade] = useState(false)
  const [closeError, setCloseError] = useState('')
  const closeInFlightRef = useRef(false)
  const hasChanges = !draftsEqual(draft, initialDraft)
  const actionBusy = busy || closingTrade

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !actionBusy) onClose()
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose, actionBusy])

  // Result summary auto-closes the modal after a short countdown.
  useEffect(() => {
    if (mode !== 'result') return
    if (countdown <= 0) {
      onClose()
      return
    }
    const id = window.setTimeout(() => setCountdown(c => c - 1), 1000)
    return () => window.clearTimeout(id)
  }, [mode, countdown, onClose])

  const handleSave = async () => {
    const parsed = parseDraft(draft)
    if (!parsed) {
      setFormError(sh.invalidLevels)
      return
    }
    setFormError('')
    setBusy(true)
    try {
      const saveResult = await signalOverrideApi.save({
        signal_id: signalId,
        sl: parsed.sl,
        tp_levels: parsed.tp_levels,
      })
      if ((saveResult.failed_legs ?? 0) > 0 && saveResult.applied_legs === 0) {
        setFormError(saveResult.errors?.[0] ?? sh.applyFailed)
        return
      }
      const total = saveResult.brokers_total ?? 0
      const updated = saveResult.brokers_updated ?? 0
      let text: string
      if (total > 1 && updated < total) {
        text = interpolate(sh.applyPartialBrokers, { updated: String(updated), total: String(total) })
      } else if (total > 1) {
        text = `${interpolate(sh.applySuccess, { count: String(saveResult.applied_legs) })} `
          + interpolate(sh.applyBrokerSummary, { updated: String(updated), total: String(total) })
      } else {
        text = interpolate(sh.applySuccess, { count: String(saveResult.applied_legs) })
      }
      onSaved({
        appliedLegs: saveResult.applied_legs,
        open: saveResult.open,
        brokersUpdated: saveResult.brokers_updated,
        brokersTotal: saveResult.brokers_total,
      })
      setResult({
        kind: 'updated',
        text,
        sub: `SL ${draft.sl.trim() || '—'} · TP ${normalizeTpLevels(draft.tpLevels).join(', ') || '—'}`,
        partial: total > 1 && updated < total,
      })
      setCountdown(RESULT_AUTO_CLOSE_SECONDS)
      setMode('result')
    } catch (e) {
      setFormError(e instanceof Error ? e.message : sh.applyFailed)
    } finally {
      setBusy(false)
    }
  }

  const handleConfirmClose = async () => {
    if (actionBusy || closeInFlightRef.current) return
    closeInFlightRef.current = true
    setClosingTrade(true)
    setCloseError('')
    try {
      const closeResult = await forceCloseTradesApi.close({ signal_id: signalId })
      const virtualDeleted = closeResult.virtual_legs_deleted ?? 0
      // Nothing actually closed (broker down, close not confirmed, wrong shard,
      // no legs): stay on the confirm view with a specific error instead of
      // showing a green success — even if queued legs were swept along the way.
      if (closeResult.closed === 0 && (closeResult.failed > 0 || virtualDeleted === 0)) {
        // Queued legs may still have been swept on the worker side — tell the
        // parent so the page refreshes those rows, then show the error here.
        if (virtualDeleted > 0) {
          onClosed({ closed: 0, failed: closeResult.failed, virtualDeleted })
        }
        setCloseError(closeResultError(sh, closeResult))
        return
      }
      onClosed({
        closed: closeResult.closed,
        failed: closeResult.failed,
        virtualDeleted,
      })
      const text = closeResult.closed > 0
        ? closeResult.failed > 0
          ? interpolate(sh.closePartial, {
              closed: String(closeResult.closed),
              total: String(closeResult.closed + closeResult.failed),
            })
          : interpolate(sh.closeSuccess, { count: String(closeResult.closed) })
        : interpolate(sh.closeQueuedRemoved, { count: String(virtualDeleted) })
      setResult({ kind: 'closed', text, partial: closeResult.failed > 0 })
      setCountdown(RESULT_AUTO_CLOSE_SECONDS)
      setMode('result')
    } catch (e) {
      // Whitelist: only surface messages the UI itself authored. Worker 500
      // text, PostgREST/HTML bodies and deploy-hint strings are internal —
      // show the generic retry line instead.
      const msg = e instanceof Error ? e.message : ''
      setCloseError(
        msg === 'Signal not found'
          ? sh.closeSignalGone
          : msg === 'Not signed in'
            ? msg
            : sh.closeRetry,
      )
    } finally {
      closeInFlightRef.current = false
      setClosingTrade(false)
    }
  }

  const headerTitle = mode === 'confirmClose'
    ? sh.closeConfirmTitle
    : mode === 'result'
      ? sh.doneTitle
      : sh.editSignal

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-signal-override-title"
    >
      <button
        type="button"
        className="absolute inset-0 bg-neutral-950/55"
        aria-label={sh.closeModal}
        onClick={onClose}
        disabled={actionBusy}
      />
      <div className="relative w-full sm:max-w-lg max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-5 py-4 border-b border-neutral-100 dark:border-neutral-800 bg-white dark:bg-neutral-900">
          <h2 id="edit-signal-override-title" className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">
            {headerTitle}
          </h2>
          <button
            type="button"
            className="p-2 rounded-lg text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors disabled:opacity-40"
            aria-label={sh.closeModal}
            onClick={onClose}
            disabled={actionBusy}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {mode === 'result' && result ? (
          <div className="p-5 space-y-4">
            <div className={result.partial
              ? 'rounded-xl border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/40 px-3 py-3 text-sm text-amber-900 dark:text-amber-200 space-y-1.5'
              : 'rounded-xl border border-green-200 dark:border-green-900 bg-green-50 dark:bg-green-950/40 px-3 py-3 text-sm text-green-800 dark:text-green-200 space-y-1.5'}>
              <p className="flex items-center gap-2 font-medium">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                {result.kind === 'closed' ? sh.closeTrade : sh.updateLiveTrades}
              </p>
              <p>{result.text}</p>
              {result.sub ? (
                <p className={result.partial
                  ? 'text-amber-700/80 dark:text-amber-300/80'
                  : 'text-green-700/80 dark:text-green-300/80'}>
                  {result.sub}
                </p>
              ) : null}
              <p className={result.partial
                ? 'text-xs text-amber-700/70 dark:text-amber-300/70'
                : 'text-xs text-green-700/70 dark:text-green-300/70'}>
                {interpolate(sh.autoCloseIn, { seconds: String(Math.max(countdown, 0)) })}
              </p>
            </div>
            <Button className="w-full" onClick={onClose}>
              {sh.closeModal}
            </Button>
          </div>
        ) : mode === 'confirmClose' ? (
          <div className="p-5 space-y-4">
            <div className="rounded-xl border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/40 px-3 py-2.5 text-sm text-amber-900 dark:text-amber-200">
              {sh.closeConfirmBody}
            </div>
            <div className="rounded-xl border border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950/50 px-3 py-2.5 text-xs text-neutral-500 space-y-1">
              <p>{sh.originalSignal}: {symbolPrefix}SL {original.sl} · TP {original.tp}</p>
              <p>{sh.overrideSignal}: {symbolPrefix}SL {current.sl} · TP {current.tp}</p>
            </div>
            {closeError ? (
              <p className="text-xs text-error-600 dark:text-error-400">{closeError}</p>
            ) : null}
            <div className="flex gap-3">
              <Button
                className="flex-1"
                variant="secondary"
                disabled={closingTrade}
                onClick={() => {
                  setCloseError('')
                  setMode('edit')
                }}
              >
                {sh.cancelAction}
              </Button>
              <Button className="flex-1" variant="danger" disabled={closingTrade} onClick={() => { void handleConfirmClose() }}>
                {closingTrade ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    {sh.closing}
                  </>
                ) : (
                  sh.confirmClose
                )}
              </Button>
            </div>
          </div>
        ) : (
          <div className="p-5 space-y-4">
            <div className="rounded-xl border border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950/50 px-3 py-2.5 text-xs text-neutral-500 space-y-1">
              <p>{sh.originalSignal}: {symbolPrefix}SL {original.sl} · TP {original.tp}</p>
              <p>{sh.overrideSignal}: {symbolPrefix}SL {current.sl} · TP {current.tp}</p>
            </div>

            <Input
              label={sh.stopLoss}
              type="number"
              step="any"
              min="0"
              disabled={busy}
              placeholder="—"
              value={draft.sl}
              onChange={e => setDraft(d => ({ ...d, sl: e.target.value }))}
            />

            <div>
              <div className="flex items-center justify-between gap-2 mb-2">
                <span className="text-xs font-medium text-neutral-500">{sh.takeProfits}</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setDraft(d => ({ ...d, tpLevels: [...d.tpLevels, ''] }))}
                  className="inline-flex items-center gap-1 text-xs font-medium text-teal-600 hover:text-teal-700 dark:text-teal-400"
                >
                  <Plus className="w-3.5 h-3.5" />
                  {sh.addTp}
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
                        aria-label={sh.removeTp}
                        onClick={() => setDraft(d => {
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

            <div className="space-y-2">
              <Button className="w-full" disabled={busy || !hasChanges} onClick={() => { void handleSave() }}>
                {busy ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    {sh.saving}
                  </>
                ) : (
                  sh.updateLiveTrades
                )}
              </Button>
              <button
                type="button"
                disabled={actionBusy}
                onClick={() => {
                  setCloseError('')
                  setMode('confirmClose')
                }}
                className="w-full rounded-xl border border-error-200 dark:border-error-900/60 px-3 py-2 text-sm font-medium text-error-600 hover:bg-error-50 dark:text-error-400 dark:hover:bg-error-950/40 transition-colors disabled:opacity-40"
              >
                {sh.closeTrade}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

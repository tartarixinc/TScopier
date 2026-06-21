import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, Plus, X } from 'lucide-react'
import { useT } from '../../context/LocaleContext'
import {
  effectiveDisplayParsedData,
  foldMgmtUpdatesIntoParsed,
  validateOverrideLevels,
  type SignalBatchRow,
  type SignalDisplayContext,
} from '../../lib/signalOverride'
import { signalOverrideApi } from '../../lib/signalOverrideApi'
import type { Signal } from '../../types/database'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'

export type OverrideDraft = {
  sl: string
  tpLevels: string[]
}

export type EditSignalOverrideSnapshot = {
  signalId: string
  initialDraft: OverrideDraft
  original: { sl: string; tp: string }
  current: { sl: string; tp: string }
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

type EditSignalOverrideModalProps = EditSignalOverrideSnapshot & {
  onClose: () => void
  onSaved: (result: { appliedLegs: number; open: boolean }) => void
}

export function EditSignalOverrideModal({
  signalId,
  initialDraft,
  original,
  current,
  onClose,
  onSaved,
}: EditSignalOverrideModalProps) {
  const t = useT()
  const sh = t.signalHistoryPage
  const [draft, setDraft] = useState(initialDraft)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState('')
  const hasChanges = !draftsEqual(draft, initialDraft)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose, busy])

  const handleSave = async () => {
    const parsed = parseDraft(draft)
    if (!parsed) {
      setFormError(sh.invalidLevels)
      return
    }
    setFormError('')
    setBusy(true)
    try {
      const result = await signalOverrideApi.save({
        signal_id: signalId,
        sl: parsed.sl,
        tp_levels: parsed.tp_levels,
      })
      if ((result.failed_legs ?? 0) > 0 && result.applied_legs === 0) {
        setFormError(result.errors?.[0] ?? sh.applyFailed)
        return
      }
      onSaved({ appliedLegs: result.applied_legs, open: result.open })
      onClose()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : sh.applyFailed)
    } finally {
      setBusy(false)
    }
  }

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
        disabled={busy}
      />
      <div className="relative w-full sm:max-w-lg max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-5 py-4 border-b border-neutral-100 dark:border-neutral-800 bg-white dark:bg-neutral-900">
          <h2 id="edit-signal-override-title" className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">
            {sh.editSignal}
          </h2>
          <button
            type="button"
            className="p-2 rounded-lg text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors disabled:opacity-40"
            aria-label={sh.closeModal}
            onClick={onClose}
            disabled={busy}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="rounded-xl border border-neutral-100 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950/50 px-3 py-2.5 text-xs text-neutral-500 space-y-1">
            <p>{sh.originalSignal}: SL {original.sl} · TP {original.tp}</p>
            <p>{sh.overrideSignal}: SL {current.sl} · TP {current.tp}</p>
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
        </div>
      </div>
    </div>,
    document.body,
  )
}

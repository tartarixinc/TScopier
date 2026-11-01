import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import {
  emptyProviderDraft,
  fetchMyProviderApplication,
  saveProviderDraft,
  submitProviderApplication,
  updateProviderProfile,
  type ProviderApplication,
  type ProviderDraft,
} from '../lib/providerApplication'

export type ProviderSaveState = 'idle' | 'saving' | 'saved' | 'error'

const AUTOSAVE_DELAY_MS = 900

function message(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback
}

/**
 * Loads the caller's provider application and keeps the editable draft synced
 * to the server (debounced). Server-side drafts survive reloads and devices.
 */
export function useProviderApplication() {
  const [application, setApplication] = useState<ProviderApplication | null>(null)
  const [draft, setDraftState] = useState<ProviderDraft>(emptyProviderDraft)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<ProviderSaveState>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const draftRef = useRef(draft)
  const dirtyRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inFlightRef = useRef<Promise<void> | null>(null)

  const editable = application == null || application.status === 'draft' || application.status === 'rejected'

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const next = await fetchMyProviderApplication(supabase)
      setApplication(next)
      if (next) {
        draftRef.current = next.draft
        setDraftState(next.draft)
      }
      dirtyRef.current = false
    } catch (cause) {
      setLoadError(message(cause, 'Unable to load your provider application.'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void Promise.resolve().then(load) }, [load])

  const persist = useCallback(async () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
    if (!dirtyRef.current) return
    const snapshot = draftRef.current
    dirtyRef.current = false
    setSaveState('saving')
    setSaveError(null)
    const run = (async () => {
      try {
        await saveProviderDraft(supabase, snapshot)
        setSaveState(dirtyRef.current ? 'saving' : 'saved')
        setApplication(current => current && current.status === 'rejected'
          ? { ...current, status: 'draft' }
          : current ?? {
            status: 'draft', draft: snapshot, termsAcceptedAt: null, submittedAt: null,
            reviewedAt: null, rejectionReason: null, slug: null, updatedAt: new Date().toISOString(),
          })
      } catch (cause) {
        dirtyRef.current = true
        setSaveState('error')
        setSaveError(message(cause, 'Unable to save your draft.'))
        throw cause
      }
    })()
    inFlightRef.current = run
    try { await run } finally { if (inFlightRef.current === run) inFlightRef.current = null }
  }, [])

  const setDraft = useCallback((patch: Partial<ProviderDraft>) => {
    const next = { ...draftRef.current, ...patch }
    draftRef.current = next
    setDraftState(next)
    dirtyRef.current = true
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => { void persist().catch(() => undefined) }, AUTOSAVE_DELAY_MS)
  }, [persist])

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  /** Saves pending edits right now (used before moving to the next step / submitting). */
  const flush = useCallback(async () => {
    if (inFlightRef.current) await inFlightRef.current.catch(() => undefined)
    await persist()
  }, [persist])

  const submit = useCallback(async (acceptTerms: boolean) => {
    setSubmitting(true)
    setSaveError(null)
    try {
      await flush()
      await submitProviderApplication(supabase, acceptTerms)
      await load()
    } catch (cause) {
      setSaveError(message(cause, 'Unable to submit your application.'))
      throw cause
    } finally {
      setSubmitting(false)
    }
  }, [flush, load])

  const updateApproved = useCallback(async () => {
    setSubmitting(true)
    setSaveError(null)
    try {
      await updateProviderProfile(supabase, draftRef.current)
      dirtyRef.current = false
      setSaveState('saved')
      await load()
    } catch (cause) {
      setSaveError(message(cause, 'Unable to update your provider profile.'))
      throw cause
    } finally {
      setSubmitting(false)
    }
  }, [load])

  return {
    application, draft, setDraft, loading, loadError, reload: load,
    editable, saveState, saveError, flush, submit, submitting, updateApproved,
  }
}

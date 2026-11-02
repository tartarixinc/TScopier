import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { ConfirmDialog } from '../components/ui/ConfirmDialog'
import { useT } from './LocaleContext'

export interface ConfirmOptions {
  title?: string
  body: string
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'danger' | 'primary'
  busyLabel?: string
  /**
   * Optional work run while the modal stays open. A rejected promise (or thrown
   * error) keeps the modal open and shows the message, so the user sees why the
   * action did not finish instead of a browser dialogue disappearing.
   */
  onConfirm?: () => void | Promise<void>
}

export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

const ConfirmDialogContext = createContext<ConfirmFn | null>(null)

/**
 * Promise-based in-app confirmation. Resolves true when the user confirms,
 * false when they cancel or the request is superseded.
 */
export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const t = useT()
  const [request, setRequest] = useState<ConfirmOptions | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const resolverRef = useRef<((confirmed: boolean) => void) | null>(null)
  // Each request gets an id so an async onConfirm that finishes after a newer
  // request has opened cannot approve (or fail) the wrong dialog.
  const activeRequestIdRef = useRef(0)

  const settle = useCallback((confirmed: boolean, requestId = activeRequestIdRef.current) => {
    if (requestId !== activeRequestIdRef.current) return
    resolverRef.current?.(confirmed)
    resolverRef.current = null
    activeRequestIdRef.current = 0
    setRequest(null)
    setBusy(false)
    setError(null)
  }, [])

  // A caller waiting on a superseded request (or an unmounted provider) must not hang.
  useEffect(() => () => {
    resolverRef.current?.(false)
    resolverRef.current = null
    activeRequestIdRef.current = 0
  }, [])

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>(resolve => {
      resolverRef.current?.(false)
      resolverRef.current = resolve
      activeRequestIdRef.current += 1
      setError(null)
      setBusy(false)
      setRequest(options)
    })
  }, [])

  const handleConfirm = useCallback(() => {
    if (!request) return
    const requestId = activeRequestIdRef.current
    if (!request.onConfirm) {
      settle(true, requestId)
      return
    }
    setBusy(true)
    setError(null)
    void Promise.resolve()
      .then(request.onConfirm)
      .then(() => settle(true, requestId))
      .catch((cause: unknown) => {
        if (requestId !== activeRequestIdRef.current) return
        setBusy(false)
        setError(cause instanceof Error ? cause.message : String(cause))
      })
  }, [request, settle])

  const handleCancel = useCallback(() => {
    if (busy) return
    settle(false)
  }, [busy, settle])

  const value = useMemo(() => confirm, [confirm])

  return (
    <ConfirmDialogContext.Provider value={value}>
      {children}
      <ConfirmDialog
        open={request != null}
        title={request?.title ?? (t.common.confirmTitle ?? 'Confirm action')}
        body={request?.body ?? ''}
        confirmLabel={request?.confirmLabel ?? (t.common.confirm ?? 'Confirm')}
        cancelLabel={request?.cancelLabel ?? t.common.cancel}
        tone={request?.tone ?? 'danger'}
        busy={busy}
        busyLabel={request?.busyLabel ?? (t.common.working ?? 'Working…')}
        error={error}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    </ConfirmDialogContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components -- a context's hook belongs next to its provider
export function useConfirm(): ConfirmFn {
  const context = useContext(ConfirmDialogContext)
  if (!context) throw new Error('useConfirm must be used within ConfirmDialogProvider')
  return context
}

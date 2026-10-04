import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react'
import { useAuth } from './AuthContext'
import { supabase } from '../lib/supabase'
import type { BrokerAccount } from '../types/database'
import { useBrokerAccountsRealtime } from '../hooks/useBrokerAccountsRealtime'
import { useBrokerReconnect } from '../hooks/useBrokerReconnect'
import {
  BROKER_ACCOUNT_CLIENT_SELECT,
  sortBrokerAccountsNewestFirst,
} from '../lib/brokerAccountSelect'
import { planLimitErrorMessage } from '../lib/telegramChannelApi'
import { useT } from './LocaleContext'
import { interpolate } from '../i18n/interpolate'
import { BrokerReconnectPasswordModal } from '../components/broker/BrokerReconnectPasswordModal'
import {
  isMigrationSwitchCase,
  isPromptDismissible,
  pickPromptBroker,
  resolveReconnectDialog,
  routeReconnectError,
  snoozedMigrationPromptIds,
  snoozeMigrationPrompt,
} from '../lib/migrationPrompt'
import { fxsocketBroker } from '../lib/fxsocketBroker'

interface BrokerAccountsContextValue {
  brokers: BrokerAccount[]
  loading: boolean
  loadError: string | null
  refreshBrokers: (options?: { silent?: boolean }) => Promise<BrokerAccount[]>
  setBrokers: Dispatch<SetStateAction<BrokerAccount[]>>
  replaceBroker: (broker: BrokerAccount) => void
  upsertBroker: (broker: BrokerAccount) => void
  removeBroker: (id: string) => void
  patchBroker: (id: string, patch: Partial<BrokerAccount>) => void
  toggleBrokerActive: (id: string, is_active: boolean) => Promise<{ error: string | null }>
  reconnectBroker: (brokerId: string) => Promise<void>
  reconnectingBrokerIds: Set<string>
  brokersNeedingReconnect: BrokerAccount[]
  isReconnecting: (brokerId: string) => boolean
  setHealthPollingPaused: (paused: boolean) => void
  healthPollingPaused: boolean
  setBackgroundConnectivityPaused: (paused: boolean) => void
  setReconnectErrorHandler: (handler: ((message: string) => void) | null) => void
  setReconnectSuccessHandler: (handler: ((brokerId: string) => void) | null) => void
  clearStoredCredentials: (brokerId: string) => Promise<{ error: string | null }>
}

const BrokerAccountsContext = createContext<BrokerAccountsContextValue | null>(null)

/**
 * Which account the automatic reconnect prompt is about, which copy it uses and
 * whether it may be closed all live in `lib/migrationPrompt`, where they can be
 * tested without a browser.
 */

export function BrokerAccountsProvider({
  children,
  enabled = true,
}: {
  children: ReactNode
  /** When false, skip broker fetch/realtime (e.g. welcome modal showing). */
  enabled?: boolean
}) {
  const { user } = useAuth()
  const t = useT()
  const bl = t.accountConfig.brokerList

  const [brokers, setBrokers] = useState<BrokerAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const initialLoadDoneRef = useRef(false)
  const [healthPollingPaused, setHealthPollingPaused] = useState(false)

  const reconnectErrorHandlerRef = useRef<((message: string) => void) | null>(null)
  const reconnectSuccessHandlerRef = useRef<((brokerId: string) => void) | null>(null)

  const setReconnectErrorHandler = useCallback((handler: ((message: string) => void) | null) => {
    reconnectErrorHandlerRef.current = handler
  }, [])

  const setReconnectSuccessHandler = useCallback((handler: ((brokerId: string) => void) | null) => {
    reconnectSuccessHandlerRef.current = handler
  }, [])

  const refreshBrokers = useCallback(async (options?: { silent?: boolean }) => {
    if (!user?.id) {
      setBrokers([])
      setLoading(false)
      setLoadError(null)
      return []
    }
    const silent = options?.silent || initialLoadDoneRef.current
    if (!silent) setLoading(true)
    setLoadError(null)
    const { data, error } = await supabase
      .from('broker_accounts')
      .select(BROKER_ACCOUNT_CLIENT_SELECT)
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
    if (error) {
      setLoadError(error.message)
      if (!silent) setLoading(false)
      return []
    }
    const next = sortBrokerAccountsNewestFirst((data ?? []) as unknown as BrokerAccount[])
    setBrokers(next)
    initialLoadDoneRef.current = true
    setLoading(false)
    return next
  }, [user?.id])

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    if (!user?.id) initialLoadDoneRef.current = false
    void refreshBrokers()
  }, [enabled, refreshBrokers, user?.id])

  const replaceBroker = useCallback((broker: BrokerAccount) => {
    setBrokers(prev => prev.map(b => (b.id === broker.id ? { ...b, ...broker } : b)))
  }, [])

  const upsertBroker = useCallback((broker: BrokerAccount) => {
    setBrokers(prev => {
      const idx = prev.findIndex(b => b.id === broker.id)
      if (idx < 0) return sortBrokerAccountsNewestFirst([...prev, broker])
      return prev.map(b => (b.id === broker.id ? { ...b, ...broker } : b))
    })
  }, [])

  const removeBroker = useCallback((id: string) => {
    setBrokers(prev => prev.filter(b => b.id !== id))
  }, [])

  const patchBroker = useCallback((id: string, patch: Partial<BrokerAccount>) => {
    setBrokers(prev => prev.map(b => (b.id === id ? { ...b, ...patch } : b)))
  }, [])

  const toggleBrokerActive = useCallback(async (id: string, is_active: boolean) => {
    if (!user) return { error: 'Not signed in' }
    setBrokers(prev => prev.map(b => (b.id === id ? { ...b, is_active } : b)))
    const { error } = await supabase
      .from('broker_accounts')
      .update({ is_active })
      .eq('id', id)
      .eq('user_id', user.id)
    if (error) {
      setBrokers(prev => prev.map(b => (b.id === id ? { ...b, is_active: !is_active } : b)))
      return { error: planLimitErrorMessage(error.message) }
    }
    return { error: null }
  }, [user])

  useBrokerAccountsRealtime(enabled ? user?.id : undefined, setBrokers)

  // ── Reconnect prompt (app-level, two-stage modal) ──────────────────────────
  // Declared before useBrokerReconnect: onError writes to it, and the prompt
  // may be the only place the customer can see the message.
  const [reconnectError, setReconnectError] = useState<string | null>(null)
  // A reconnect that just succeeded, so the dialog can confirm it before it
  // moves on to the next account or closes. Cleared when the customer
  // continues or dismisses the confirmation.
  const [reconnectSuccessId, setReconnectSuccessId] = useState<string | null>(null)
  // A reconnect the customer started, kept so a failure can still anchor the
  // dialog after the account's row leaves the needs-reconnect list (a
  // mid-connect `pending` row is not on it). Cleared on cancel and on success.
  const [reconnectAttemptId, setReconnectAttemptId] = useState<string | null>(null)
  // Accounts postponed with "Remind me later" — real state so the prompt
  // re-picks immediately; the sessionStorage copy is only for the next load.
  const [snoozedIds, setSnoozedIds] = useState<ReadonlySet<string>>(() => snoozedMigrationPromptIds())

  const {
    reconnectBroker: reconnectBrokerBase,
    reconnectingBrokerIds,
    brokersNeedingReconnect,
    isReconnecting,
    passwordPromptBroker,
    submitPasswordPrompt,
    cancelPasswordPrompt,
  } = useBrokerReconnect({
    brokers,
    upsertBroker,
    reconnectFailedLabel: bl.reconnectFailed,
    onError: (message) => {
      routeReconnectError(message, {
        dialog: setReconnectError,
        page: reconnectErrorHandlerRef.current,
      })
    },
    onSuccess: (brokerId) => {
      setReconnectError(null)
      setReconnectSuccessId(brokerId)
      // A reconnected account no longer needs postponing — forget any snooze
      // so a future reconnect need prompts again immediately.
      setSnoozedIds(prev => {
        if (!prev.has(brokerId)) return prev
        const next = new Set(prev)
        next.delete(brokerId)
        return next
      })
      reconnectSuccessHandlerRef.current?.(brokerId)
    },
  })

  // Every entry point (dialog, config page) records its attempt, so a failure
  // can always anchor the dialog even after the row leaves the
  // needs-reconnect list. Starting a new attempt also clears the last error.
  const reconnectBroker = useCallback(async (brokerId: string) => {
    setReconnectAttemptId(brokerId)
    setReconnectError(null)
    return reconnectBrokerBase(brokerId)
  }, [reconnectBrokerBase])

  const noopClear = useCallback(async () => ({ error: null as string | null }), [])

  const migrationPromptBroker = useMemo(
    () => pickPromptBroker(
      // "Remind me later" hides the account from the queue until the next app
      // load, so the next queued account can be dealt with immediately.
      brokersNeedingReconnect.filter(broker => !snoozedIds.has(broker.id)),
      reconnectingBrokerIds,
    ),
    [brokersNeedingReconnect, reconnectingBrokerIds, snoozedIds],
  )

  const successBroker = reconnectSuccessId
    ? (brokers.find(b => b.id === reconnectSuccessId) ?? null)
    : null
  // While the bridge is still working, the dialog stays on the account the
  // customer submitted instead of jumping ahead to the next one.
  const inflightBrokerId = [...reconnectingBrokerIds][0]
  const inflightBroker = inflightBrokerId
    ? (brokers.find(b => b.id === inflightBrokerId) ?? null)
    : null
  // A failed attempt keeps the dialog open on its account even when the row
  // is mid-connect (`pending`) and therefore off the needs-reconnect list —
  // otherwise the error would land behind a dialog that just closed.
  const errorAnchor =
    reconnectError && reconnectAttemptId
      ? (brokers.find(b => b.id === reconnectAttemptId) ?? null)
      : null

  const { active: activeBroker, stage: modalStage } = resolveReconnectDialog({
    passwordPrompt: passwordPromptBroker,
    success: successBroker,
    inflight: inflightBroker,
    errorAnchor,
    migrationPrompt: migrationPromptBroker,
  })

  // The wording follows the cause, not which prompt happens to be open.
  const migrationCopy = isMigrationSwitchCase(activeBroker)
  // Only a dialog the customer opened themselves may be closed. The automatic
  // prompt is stuck until the account reconnects. While the bridge is working
  // there is nothing to cancel, so it is forced shut — an X or Escape that
  // does nothing is worse than no X at all.
  const modalDismissible =
    modalStage === 'connecting'
      ? false
      : isPromptDismissible(brokersNeedingReconnect, activeBroker)

  // The handlers read the latest brokers through refs so their identity stays
  // stable while health polling replaces the list: a fresh identity re-runs
  // the dialog's focus effect and steals focus on every poll.
  const passwordPromptBrokerRef = useRef(passwordPromptBroker)
  const successBrokerRef = useRef(successBroker)
  const activeBrokerRef = useRef(activeBroker)
  useEffect(() => {
    passwordPromptBrokerRef.current = passwordPromptBroker
    successBrokerRef.current = successBroker
    activeBrokerRef.current = activeBroker
  })

  const handleModalCancel = useCallback(() => {
    if (passwordPromptBrokerRef.current) cancelPasswordPrompt()
    setReconnectError(null)
    setReconnectAttemptId(null)
    setReconnectSuccessId(null)
  }, [cancelPasswordPrompt])

  /** "Remind me later": hide this account until the next app load, then move on. */
  const handleRemindLater = useCallback(() => {
    // Unwind any in-flight attempt first: on the password stage the reconnect
    // is awaiting this prompt, and leaving it unresolved would hold the
    // account's reconnect lease for the rest of the session.
    if (passwordPromptBrokerRef.current) cancelPasswordPrompt()
    const active = activeBrokerRef.current
    if (active) {
      snoozeMigrationPrompt(active.id)
      setSnoozedIds(prev => new Set(prev).add(active.id))
    }
    setReconnectError(null)
    setReconnectAttemptId(null)
    setReconnectSuccessId(null)
  }, [cancelPasswordPrompt])

  /** Delete = the permanent exit for an account that cannot be reconnected. */
  const handleDeleteAccount = useCallback(async () => {
    const active = activeBrokerRef.current
    if (!active) return
    // Same unwind as "remind me later": never leave a reconnect awaiting a
    // prompt for an account that is about to disappear.
    if (passwordPromptBrokerRef.current) cancelPasswordPrompt()
    try {
      await fxsocketBroker.delete(active.id, active.provider as 'fxsocket' | 'mtapi' | undefined)
    } catch (err) {
      setReconnectError(err instanceof Error ? err.message : bl.deleteFailed)
      return
    }
    removeBroker(active.id)
    setSnoozedIds(prev => {
      if (!prev.has(active.id)) return prev
      const next = new Set(prev)
      next.delete(active.id)
      return next
    })
    setReconnectError(null)
    setReconnectAttemptId(null)
    setReconnectSuccessId(null)
  }, [bl.deleteFailed, cancelPasswordPrompt, removeBroker])

  const handleModalBack = useCallback(() => {
    // Abort the password prompt only — the details stage stays up, and nothing
    // is suppressed, so the customer can step forward again.
    if (passwordPromptBrokerRef.current) cancelPasswordPrompt()
  }, [cancelPasswordPrompt])

  const handleModalContinue = useCallback(() => {
    setReconnectError(null)
    // Success confirmation: clear it and fall through to the next account, or
    // close the dialog when none are left.
    if (successBrokerRef.current) {
      setReconnectSuccessId(null)
      setReconnectAttemptId(null)
      return
    }
    // The active account covers both the automatic prompt and a failed
    // attempt's retry (its row may be pending, so the prompt is not there).
    const active = activeBrokerRef.current
    if (active) void reconnectBroker(active.id)
  }, [reconnectBroker])

  // On the success confirmation, the button name follows what comes next
  // (paused accounts cannot be advanced to, so they do not count).
  const hasMoreAfterSuccess = reconnectSuccessId
    ? brokersNeedingReconnect.some(b => b.id !== reconnectSuccessId && b.is_active !== false)
    : false

  // Several accounts queued: say so up front instead of letting the customer
  // discover the queue one password prompt at a time. Paused accounts are
  // never queued, so they are not counted.
  const reconnectManyHint = useMemo(() => {
    const queued = brokersNeedingReconnect.filter(b => b.is_active !== false).length
    return queued > 1 ? interpolate(bl.reconnectManyAccountsHint, { count: queued }) : null
  }, [brokersNeedingReconnect, bl.reconnectManyAccountsHint])

  const modalCopy = useMemo(() => {
    const shared = {
      passwordLabel: bl.reconnectPasswordLabel,
      passwordPlaceholder: bl.reconnectPasswordPlaceholder,
      remindLater: bl.remindLater,
      deleteAccountLink: bl.deleteAccountLink,
      deleteConfirmTitle: bl.deleteConfirmTitle,
      deleteConfirmBody: bl.deleteConfirmBody,
      deleteConfirmNote: bl.deleteConfirmNote,
      deleteConfirmCta: bl.deleteConfirmCta,
      detailLogin: bl.detailLogin,
      detailServer: bl.detailServer,
      reconnect: bl.reconnect,
      cancel: t.common.cancel,
      back: bl.reconnectMigrationBack,
      successAction: hasMoreAfterSuccess ? bl.reconnectSuccessNext : bl.reconnectSuccessDone,
      // Only the stages where the customer is about to act: a hint on the
      // "connecting" spinner or the success tick would just be noise.
      ...((modalStage === 'details' || modalStage === 'password') && reconnectManyHint
        ? { hint: reconnectManyHint }
        : {}),
    }
    if (modalStage === 'connecting') {
      return { title: bl.reconnectConnectingTitle, body: bl.reconnectConnectingBody, ...shared }
    }
    if (modalStage === 'success') {
      return { title: bl.reconnectSuccessTitle, body: bl.reconnectSuccessBody, ...shared }
    }
    if (!migrationCopy) {
      return { title: bl.reconnectPasswordTitle, body: bl.reconnectPasswordBody, ...shared }
    }
    return modalStage === 'password'
      ? { title: bl.reconnectMigrationPasswordTitle, body: bl.reconnectMigrationPasswordBody, ...shared }
      : { title: bl.reconnectMigrationTitle, body: bl.reconnectMigrationBody, ...shared }
  }, [bl, migrationCopy, modalStage, t.common.cancel, hasMoreAfterSuccess, reconnectManyHint])

  const value = useMemo(
    (): BrokerAccountsContextValue => ({
      brokers,
      loading,
      loadError,
      refreshBrokers,
      setBrokers,
      replaceBroker,
      upsertBroker,
      removeBroker,
      patchBroker,
      toggleBrokerActive,
      reconnectBroker,
      reconnectingBrokerIds,
      brokersNeedingReconnect,
      isReconnecting,
      setHealthPollingPaused,
      healthPollingPaused,
      setBackgroundConnectivityPaused: () => {},
      setReconnectErrorHandler,
      setReconnectSuccessHandler,
      clearStoredCredentials: noopClear,
    }),
    [
      brokers,
      loading,
      loadError,
      refreshBrokers,
      replaceBroker,
      upsertBroker,
      removeBroker,
      patchBroker,
      toggleBrokerActive,
      reconnectBroker,
      reconnectingBrokerIds,
      brokersNeedingReconnect,
      isReconnecting,
      healthPollingPaused,
      setReconnectErrorHandler,
      setReconnectSuccessHandler,
      noopClear,
    ],
  )

  return (
    <BrokerAccountsContext.Provider value={value}>
      {children}
      {/* Remount on stage or account change so the password field always
          starts empty — never carry one account's password to another. */}
      <BrokerReconnectPasswordModal
        key={`${modalStage}:${activeBroker?.id ?? ''}`}
        open={activeBroker != null}
        broker={activeBroker}
        stage={modalStage}
        copy={modalCopy}
        onSubmit={submitPasswordPrompt}
        onCancel={handleModalCancel}
        onContinue={handleModalContinue}
        onBack={migrationCopy ? handleModalBack : undefined}
        error={reconnectError}
        dismissible={modalDismissible}
        onRemindLater={handleRemindLater}
        onDeleteAccount={() => { void handleDeleteAccount() }}
      />
    </BrokerAccountsContext.Provider>
  )
}

export function useBrokerAccounts(): BrokerAccountsContextValue {
  const ctx = useContext(BrokerAccountsContext)
  if (!ctx) {
    throw new Error('useBrokerAccounts must be used within BrokerAccountsProvider')
  }
  return ctx
}

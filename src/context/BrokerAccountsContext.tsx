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
import { BrokerReconnectPasswordModal } from '../components/broker/BrokerReconnectPasswordModal'

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
 * Session-scoped suppression for the migration reconnect prompt. Closing the
 * prompt keeps it closed for the rest of this browser session; the dashboard
 * banner stays as the persistent fallback. Cleared automatically when the tab
 * session ends, and never set by a successful reconnect.
 */
const MIGRATION_PROMPT_DISMISS_KEY = 'tscopier_reconnect_migration_dismissed'

function readMigrationPromptDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(MIGRATION_PROMPT_DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

function writeMigrationPromptDismissed(): void {
  try {
    window.sessionStorage.setItem(MIGRATION_PROMPT_DISMISS_KEY, '1')
  } catch {
    // Storage unavailable (private mode/blocked) — dismissal then only lasts
    // for this mount, which is still shorter than nagging forever.
  }
}

/**
 * The case this prompt exists for: an account moved to MTAPI that has never
 * connected through it, so it cannot copy anything yet. Anything else — an
 * ordinary FxSocket session expiry, or an MTAPI session that dropped later —
 * keeps the existing session-expiry wording.
 */
function isMigrationSwitchCase(broker: BrokerAccount | null | undefined): boolean {
  return broker?.provider === 'mtapi' && (broker.mtapi_status ?? null) == null
}

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

  const {
    reconnectBroker,
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
      // Pages register their own toast; when none does (the prompt can open on
      // any page) keep the message so the dialog can show it.
      if (reconnectErrorHandlerRef.current) reconnectErrorHandlerRef.current(message)
      else setReconnectError(message)
    },
    onSuccess: (brokerId) => {
      setReconnectError(null)
      reconnectSuccessHandlerRef.current?.(brokerId)
    },
  })

  const noopClear = useCallback(async () => ({ error: null as string | null }), [])

  // ── Migration reconnect prompt (app-level, two-stage modal) ────────────────
  const [migrationPromptDismissed, setMigrationPromptDismissed] =
    useState<boolean>(readMigrationPromptDismissed)
  const [reconnectError, setReconnectError] = useState<string | null>(null)

  const dismissMigrationPrompt = useCallback(() => {
    setMigrationPromptDismissed(true)
    setReconnectError(null)
    writeMigrationPromptDismissed()
  }, [])

  // Derived rather than stored: whenever an account needs reconnecting and the
  // prompt has not been dismissed this session, it is up — on any page. Paused
  // accounts are skipped (copying is off, so there is nothing to keep running),
  // and an account whose reconnect is already in flight is skipped so the dialog
  // never drops back to stage 1 while the attempt is running.
  const migrationPromptBroker = useMemo(() => {
    if (migrationPromptDismissed) return null
    return brokersNeedingReconnect.find(
      broker => broker.is_active !== false && !reconnectingBrokerIds.has(broker.id),
    ) ?? null
  }, [brokersNeedingReconnect, migrationPromptDismissed, reconnectingBrokerIds])

  const activeBroker = passwordPromptBroker ?? migrationPromptBroker
  const modalStage: 'details' | 'password' = passwordPromptBroker ? 'password' : 'details'
  // The wording follows the cause, not which prompt happens to be open: only a
  // row moved to MTAPI that has never connected through it gets the migration
  // text. An ordinary FxSocket expiry — or a later MTAPI session drop — keeps
  // "Broker session expired".
  const migrationCopy = isMigrationSwitchCase(activeBroker)

  const handleModalCancel = () => {
    // Closing the dialog while an account still needs reconnecting counts as a
    // dismissal: suppress the automatic prompt for the rest of this session.
    const suppressAutomaticPrompt = !migrationPromptDismissed && brokersNeedingReconnect.length > 0
    if (passwordPromptBroker) cancelPasswordPrompt()
    if (suppressAutomaticPrompt) dismissMigrationPrompt()
  }

  const handleModalBack = () => {
    // Abort the password prompt only — the details stage stays up, and nothing
    // is suppressed, so the customer can step forward again.
    if (passwordPromptBroker) cancelPasswordPrompt()
  }

  const handleModalContinue = () => {
    setReconnectError(null)
    if (migrationPromptBroker) void reconnectBroker(migrationPromptBroker.id)
  }

  const modalCopy = useMemo(() => {
    const shared = {
      passwordLabel: bl.reconnectPasswordLabel,
      passwordHint: bl.reconnectPasswordHint,
      passwordPlaceholder: bl.reconnectPasswordPlaceholder,
      rememberPasswordLabel: bl.rememberPasswordLabel,
      rememberPasswordHint: bl.rememberPasswordHint,
      detailLogin: bl.detailLogin,
      detailServer: bl.detailServer,
      reconnect: bl.reconnect,
      cancel: t.common.cancel,
      back: bl.reconnectMigrationBack,
    }
    if (!migrationCopy) {
      return { title: bl.reconnectPasswordTitle, body: bl.reconnectPasswordBody, ...shared }
    }
    return modalStage === 'password'
      ? { title: bl.reconnectMigrationPasswordTitle, body: bl.reconnectMigrationPasswordBody, ...shared }
      : { title: bl.reconnectMigrationTitle, body: bl.reconnectMigrationBody, ...shared }
  }, [bl, migrationCopy, modalStage, t.common.cancel])

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
      {/* Remount on stage change so the password field always starts empty. */}
      <BrokerReconnectPasswordModal
        key={modalStage}
        open={activeBroker != null}
        broker={activeBroker}
        stage={modalStage}
        copy={modalCopy}
        onSubmit={submitPasswordPrompt}
        onCancel={handleModalCancel}
        onContinue={handleModalContinue}
        onBack={migrationCopy ? handleModalBack : undefined}
        error={reconnectError}
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

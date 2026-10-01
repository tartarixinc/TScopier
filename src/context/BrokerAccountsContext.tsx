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
import {
  isMigrationSwitchCase,
  isPromptDismissible,
  pickPromptBroker,
  routeReconnectError,
} from '../lib/migrationPrompt'

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
      routeReconnectError(message, {
        dialog: setReconnectError,
        page: reconnectErrorHandlerRef.current,
      })
    },
    onSuccess: (brokerId) => {
      setReconnectError(null)
      reconnectSuccessHandlerRef.current?.(brokerId)
    },
  })

  const noopClear = useCallback(async () => ({ error: null as string | null }), [])

  const migrationPromptBroker = useMemo(
    () => pickPromptBroker(brokersNeedingReconnect, reconnectingBrokerIds),
    [brokersNeedingReconnect, reconnectingBrokerIds],
  )

  const activeBroker = passwordPromptBroker ?? migrationPromptBroker
  const modalStage: 'details' | 'password' = passwordPromptBroker ? 'password' : 'details'
  // The wording follows the cause, not which prompt happens to be open.
  const migrationCopy = isMigrationSwitchCase(activeBroker)
  // Only a dialog the customer opened themselves may be closed. The automatic
  // prompt is stuck until the account reconnects.
  const modalDismissible = isPromptDismissible(brokersNeedingReconnect, activeBroker)

  const handleModalCancel = () => {
    if (passwordPromptBroker) cancelPasswordPrompt()
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
        dismissible={modalDismissible}
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

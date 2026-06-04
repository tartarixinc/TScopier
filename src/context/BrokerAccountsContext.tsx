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
import { useLocation } from 'react-router-dom'
import { useAuth } from './AuthContext'
import { useLocale } from './LocaleContext'
import { supabase } from '../lib/supabase'
import { metatraderApi } from '../lib/metatraderapi'
import type { BrokerAccount } from '../types/database'
import { useBrokerAccountsRealtime } from '../hooks/useBrokerAccountsRealtime'
import { useBrokerConnectionHealth } from '../hooks/useBrokerConnectionHealth'
import { useBrokerConnectionRecovery } from '../hooks/useBrokerConnectionRecovery'
import { useBrokerReconnect, type BrokerPasswordPromptResult } from '../hooks/useBrokerReconnect'
import { useBrokerSessionFailureRealtime } from '../hooks/useBrokerSessionFailureRealtime'
import { BrokerReconnectPasswordModal } from '../components/broker/BrokerReconnectPasswordModal'
import { BROKER_ACCOUNT_CLIENT_SELECT } from '../lib/brokerAccountSelect'

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
  reconnectBroker: ReturnType<typeof useBrokerReconnect>['reconnectBroker']
  reconnectingBrokerIds: Set<string>
  brokersNeedingReconnect: BrokerAccount[]
  isReconnecting: (brokerId: string) => boolean
  setHealthPollingPaused: (paused: boolean) => void
  /** Pauses health checks, auto-reconnect sweeps, and silent reconnect side-effects. */
  setBackgroundConnectivityPaused: (paused: boolean) => void
  setReconnectErrorHandler: (handler: ((message: string) => void) | null) => void
  setReconnectSuccessHandler: (handler: ((brokerId: string) => void) | null) => void
  clearStoredCredentials: (brokerId: string) => Promise<{ error: string | null }>
}

const BrokerAccountsContext = createContext<BrokerAccountsContextValue | null>(null)

export function BrokerAccountsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const { t } = useLocale()
  const { pathname } = useLocation()
  const bl = t.accountConfig.brokerList

  const [brokers, setBrokers] = useState<BrokerAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [manualConnectivityPaused, setManualConnectivityPaused] = useState(false)
  const initialLoadDoneRef = useRef(false)

  const reconnectErrorHandlerRef = useRef<((message: string) => void) | null>(null)
  const reconnectSuccessHandlerRef = useRef<((brokerId: string) => void) | null>(null)
  const passwordRequestRef = useRef<{
    brokerId: string
    resolve: (result: BrokerPasswordPromptResult | null) => void
  } | null>(null)
  const [passwordModalBrokerId, setPasswordModalBrokerId] = useState<string | null>(null)

  /** Pause health polls / auto-reconnect while the password modal is open (avoids UI jank). */
  const routePausesHealthChecks = pathname === '/account-configuration'
  const passwordModalOpen = passwordModalBrokerId != null
  const healthChecksPaused = routePausesHealthChecks || manualConnectivityPaused || passwordModalOpen
  const recoveryPaused = manualConnectivityPaused || passwordModalOpen

  const requestReconnectPassword = useCallback((brokerId: string): Promise<BrokerPasswordPromptResult | null> => {
    return new Promise(resolve => {
      passwordRequestRef.current = { brokerId, resolve }
      setPasswordModalBrokerId(brokerId)
    })
  }, [])

  const finishPasswordRequest = useCallback((result: BrokerPasswordPromptResult | null) => {
    const pending = passwordRequestRef.current
    if (!pending) return
    passwordRequestRef.current = null
    setPasswordModalBrokerId(null)
    pending.resolve(result)
  }, [])

  const handlePasswordModalSubmit = useCallback((payload: { password: string; rememberPassword: boolean }) => {
    finishPasswordRequest(payload)
  }, [finishPasswordRequest])

  const handlePasswordModalCancel = useCallback(() => {
    finishPasswordRequest(null)
  }, [finishPasswordRequest])

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
      .order('created_at')
    if (error) {
      setLoadError(error.message)
      if (!silent) setLoading(false)
      return []
    }
    const next = (data ?? []) as unknown as BrokerAccount[]
    setBrokers(next)
    initialLoadDoneRef.current = true
    setLoading(false)
    return next
  }, [user?.id])

  useEffect(() => {
    if (!user?.id) initialLoadDoneRef.current = false
    void refreshBrokers()
  }, [refreshBrokers, user?.id])

  const replaceBroker = useCallback((broker: BrokerAccount) => {
    setBrokers(prev => prev.map(b => (b.id === broker.id ? broker : b)))
  }, [])

  const upsertBroker = useCallback((broker: BrokerAccount) => {
    setBrokers(prev => {
      const idx = prev.findIndex(b => b.id === broker.id)
      if (idx < 0) return [...prev, broker]
      return prev.map(b => (b.id === broker.id ? broker : b))
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
      return { error: error.message }
    }
    return { error: null }
  }, [user])

  const {
    reconnectBroker,
    reconnectingBrokerIds,
    brokersNeedingReconnect,
    isReconnecting,
  } = useBrokerReconnect({
    brokers,
    setBrokers,
    autoReconnect: true,
    autoReconnectActiveOnly: true,
    autoReconnectPaused: recoveryPaused,
    reconnectFailedLabel: bl.reconnectFailed,
    requestPassword: requestReconnectPassword,
    onError: message => reconnectErrorHandlerRef.current?.(message),
    onClearError: () => {},
    onReconnectSuccess: brokerId => reconnectSuccessHandlerRef.current?.(brokerId),
  })

  useBrokerAccountsRealtime(user?.id, setBrokers, { silentReconnect: !recoveryPaused })
  useBrokerConnectionHealth(brokers, setBrokers, {
    enabled: !healthChecksPaused,
    refreshOnVisible: !healthChecksPaused,
  })
  useBrokerConnectionRecovery(brokers, setBrokers, { enabled: !recoveryPaused })
  useBrokerSessionFailureRealtime(user?.id, setBrokers, { silentReconnect: !recoveryPaused })

  const clearStoredCredentials = useCallback(async (brokerId: string) => {
    try {
      const { broker } = await metatraderApi.clearStoredCredentials(brokerId)
      if (broker) {
        setBrokers(prev => prev.map(b => (b.id === brokerId ? { ...b, ...broker } : b)))
      } else {
        patchBroker(brokerId, { auto_reconnect_enabled: false, password_updated_at: null })
      }
      return { error: null }
    } catch (err) {
      return { error: err instanceof Error ? err.message : bl.reconnectFailed }
    }
  }, [bl.reconnectFailed, patchBroker])

  const passwordModalBroker = useMemo(
    () => (passwordModalBrokerId ? brokers.find(b => b.id === passwordModalBrokerId) ?? null : null),
    [brokers, passwordModalBrokerId],
  )

  const passwordModalCopy = useMemo(
    () => ({
      title: bl.reconnectPasswordTitle,
      body: bl.reconnectPasswordBody,
      passwordLabel: bl.reconnectPasswordLabel,
      passwordHint: bl.reconnectPasswordHint,
      passwordPlaceholder: bl.reconnectPasswordPlaceholder,
      rememberPasswordLabel: bl.rememberPasswordLabel,
      rememberPasswordHint: bl.rememberPasswordHint,
      detailLogin: bl.detailLogin,
      detailServer: bl.detailServer,
      reconnect: bl.reconnect,
      cancel: t.common.cancel,
    }),
    [
      bl.reconnectPasswordTitle,
      bl.reconnectPasswordBody,
      bl.reconnectPasswordLabel,
      bl.reconnectPasswordHint,
      bl.reconnectPasswordPlaceholder,
      bl.rememberPasswordLabel,
      bl.rememberPasswordHint,
      bl.detailLogin,
      bl.detailServer,
      bl.reconnect,
      t.common.cancel,
    ],
  )

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
      setHealthPollingPaused: setManualConnectivityPaused,
      setBackgroundConnectivityPaused: setManualConnectivityPaused,
      setReconnectErrorHandler: handler => {
        reconnectErrorHandlerRef.current = handler
      },
      setReconnectSuccessHandler: handler => {
        reconnectSuccessHandlerRef.current = handler
      },
      clearStoredCredentials,
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
      clearStoredCredentials,
    ],
  )

  return (
    <BrokerAccountsContext.Provider value={value}>
      {children}
      <BrokerReconnectPasswordModal
        open={passwordModalOpen}
        broker={passwordModalBroker}
        defaultRememberPassword={passwordModalBroker?.auto_reconnect_enabled ?? false}
        copy={passwordModalCopy}
        onSubmit={handlePasswordModalSubmit}
        onCancel={handlePasswordModalCancel}
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

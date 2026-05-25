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
import type { BrokerAccount } from '../types/database'
import { useBrokerAccountsRealtime } from '../hooks/useBrokerAccountsRealtime'
import { useBrokerConnectionHealth } from '../hooks/useBrokerConnectionHealth'
import { useBrokerReconnect } from '../hooks/useBrokerReconnect'
import { useBrokerSessionFailureRealtime } from '../hooks/useBrokerSessionFailureRealtime'

interface BrokerAccountsContextValue {
  brokers: BrokerAccount[]
  loading: boolean
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
}

const BrokerAccountsContext = createContext<BrokerAccountsContextValue | null>(null)

export function BrokerAccountsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const { t } = useLocale()
  const { pathname } = useLocation()
  const bl = t.accountConfig.brokerList

  const [brokers, setBrokers] = useState<BrokerAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [manualConnectivityPaused, setManualConnectivityPaused] = useState(false)
  const initialLoadDoneRef = useRef(false)

  const routePausesConnectivity = pathname === '/account-configuration'
  const backgroundConnectivityPaused = routePausesConnectivity || manualConnectivityPaused

  const reconnectErrorHandlerRef = useRef<((message: string) => void) | null>(null)
  const reconnectSuccessHandlerRef = useRef<((brokerId: string) => void) | null>(null)

  const refreshBrokers = useCallback(async (options?: { silent?: boolean }) => {
    if (!user?.id) {
      setBrokers([])
      setLoading(false)
      return []
    }
    const silent = options?.silent || initialLoadDoneRef.current
    if (!silent) setLoading(true)
    const { data, error } = await supabase
      .from('broker_accounts')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at')
    if (error) {
      if (!silent) setLoading(false)
      throw new Error(error.message)
    }
    const next = (data ?? []) as BrokerAccount[]
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
    autoReconnect: false,
    autoReconnectActiveOnly: true,
    autoReconnectPaused: backgroundConnectivityPaused,
    reconnectFailedLabel: bl.reconnectFailed,
    passwordPrompt: bl.reconnectPasswordPrompt,
    onError: message => reconnectErrorHandlerRef.current?.(message),
    onClearError: () => {},
    onReconnectSuccess: brokerId => reconnectSuccessHandlerRef.current?.(brokerId),
  })

  const connectivityActive = !backgroundConnectivityPaused

  useBrokerAccountsRealtime(user?.id, setBrokers, { silentReconnect: connectivityActive })
  useBrokerConnectionHealth(brokers, setBrokers, {
    enabled: connectivityActive,
    refreshOnVisible: connectivityActive,
  })
  useBrokerSessionFailureRealtime(user?.id, setBrokers, { silentReconnect: connectivityActive })

  const value = useMemo(
    (): BrokerAccountsContextValue => ({
      brokers,
      loading,
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
    }),
    [
      brokers,
      loading,
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
    ],
  )

  return <BrokerAccountsContext.Provider value={value}>{children}</BrokerAccountsContext.Provider>
}

export function useBrokerAccounts(): BrokerAccountsContextValue {
  const ctx = useContext(BrokerAccountsContext)
  if (!ctx) {
    throw new Error('useBrokerAccounts must be used within BrokerAccountsProvider')
  }
  return ctx
}

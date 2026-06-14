import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { BrokerAccount } from '../types/database'
import { ConnectTradingAccountModal } from '../components/broker/ConnectTradingAccountModal'
import { BrokerConnectedSuccessModal } from '../components/broker/BrokerConnectedSuccessModal'
import { BrokerBulkConnectSummaryModal } from '../components/broker/BrokerBulkConnectSummaryModal'
import { useBrokerAccounts } from './BrokerAccountsContext'
import { useT } from './LocaleContext'
import type { BulkConnectResult } from '../lib/bulkConnectBrokers'

type AddTradingAccountContextValue = {
  openAddTradingAccount: () => void
  pendingConfigureBrokerId: string | null
  clearPendingConfigureBroker: () => void
  requestConfigureBroker: (brokerId: string) => void
}

const AddTradingAccountContext = createContext<AddTradingAccountContextValue | null>(null)

export function AddTradingAccountProvider({ children }: { children: ReactNode }) {
  const t = useT()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { brokers } = useBrokerAccounts()
  const sc = t.accountConfig.brokerConnectedSuccess
  const bc = t.accountConfig.bulkConnect
  const bl = t.accountConfig.brokerList

  const [open, setOpen] = useState(false)
  const [connectedBroker, setConnectedBroker] = useState<BrokerAccount | null>(null)
  const [batchResult, setBatchResult] = useState<BulkConnectResult | null>(null)
  const [pendingConfigureBrokerId, setPendingConfigureBrokerId] = useState<string | null>(null)

  const openAddTradingAccount = useCallback(() => {
    setOpen(true)
  }, [])

  const clearPendingConfigureBroker = useCallback(() => {
    setPendingConfigureBrokerId(null)
  }, [])

  const requestConfigureBroker = useCallback(
    (brokerId: string) => {
      setPendingConfigureBrokerId(brokerId)
      if (pathname !== '/brokers') {
        navigate('/brokers')
      }
    },
    [navigate, pathname],
  )

  const handleConnectSuccess = useCallback((broker: BrokerAccount) => {
    setOpen(false)
    setConnectedBroker(broker)
  }, [])

  const handleBatchSuccess = useCallback((result: BulkConnectResult) => {
    setOpen(false)
    if (result.linkedCount === 1 && result.failedCount === 0 && result.skippedCount === 0) {
      const linked = result.rows.find(row => row.status === 'linked' && row.account)
      if (linked?.account) {
        setConnectedBroker(linked.account)
        return
      }
    }
    if (result.linkedCount > 0 || result.failedCount > 0) {
      setBatchResult(result)
    }
  }, [])

  const dismissSuccess = useCallback(() => {
    setConnectedBroker(null)
  }, [])

  const dismissBatchSummary = useCallback(() => {
    setBatchResult(null)
  }, [])

  const handleAddChannel = useCallback(() => {
    setConnectedBroker(null)
    navigate('/channels')
  }, [navigate])

  const handleConfigure = useCallback(() => {
    if (!connectedBroker) return
    const brokerId = connectedBroker.id
    setConnectedBroker(null)
    requestConfigureBroker(brokerId)
  }, [connectedBroker, requestConfigureBroker])

  const handleViewBrokers = useCallback(() => {
    setBatchResult(null)
    if (pathname !== '/brokers') {
      navigate('/brokers')
    }
  }, [navigate, pathname])

  const value = useMemo(
    () => ({
      openAddTradingAccount,
      pendingConfigureBrokerId,
      clearPendingConfigureBroker,
      requestConfigureBroker,
    }),
    [
      openAddTradingAccount,
      pendingConfigureBrokerId,
      clearPendingConfigureBroker,
      requestConfigureBroker,
    ],
  )

  const handleClose = useCallback(() => {
    setOpen(false)
  }, [])

  const successBroker = connectedBroker
    ? brokers.find(b => b.id === connectedBroker.id) ?? connectedBroker
    : null

  return (
    <AddTradingAccountContext.Provider value={value}>
      {children}
      <ConnectTradingAccountModal
        open={open}
        onClose={handleClose}
        onSuccess={handleConnectSuccess}
        onBatchSuccess={handleBatchSuccess}
      />
      <BrokerConnectedSuccessModal
        open={successBroker != null}
        broker={successBroker}
        copy={{
          title: sc.title,
          titlePending: sc.titlePending,
          body: sc.body,
          bodyPending: sc.bodyPending,
          addChannel: sc.addChannel,
          configure: sc.configure,
          detailLogin: bl.detailLogin,
          detailServer: bl.detailServer,
          dismiss: t.common.cancel,
        }}
        onAddChannel={handleAddChannel}
        onConfigure={handleConfigure}
        onDismiss={dismissSuccess}
      />
      <BrokerBulkConnectSummaryModal
        open={batchResult != null}
        result={batchResult}
        copy={bc}
        onDismiss={dismissBatchSummary}
        onViewBrokers={handleViewBrokers}
      />
    </AddTradingAccountContext.Provider>
  )
}

export function useAddTradingAccount(): AddTradingAccountContextValue {
  const context = useContext(AddTradingAccountContext)
  if (!context) {
    throw new Error('useAddTradingAccount must be used within AddTradingAccountProvider')
  }
  return context
}

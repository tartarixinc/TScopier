import { useCallback, useState } from 'react'
import { useT } from '../context/LocaleContext'
import { interpolate } from '../i18n/interpolate'
import { forceCloseTradesApi } from '../lib/forceCloseTradesApi'
import type { BrokerActiveSignalTrade, PortfolioBrokerActiveSignals } from '../lib/brokerStats'

export function channelCloseKey(brokerId: string, channelId: string): string {
  return `${brokerId}:${channelId}`
}

export type ForceCloseConfirmRequest = {
  scope: 'channel' | 'broker' | 'all'
  channelLabel: string
  accountLabel?: string
  channelCount: number
  totalLots: number
  pnl: number
  positionCount: number
  accountCount: number
  brokerId?: string
  channelId?: string
  brokerIds?: string[]
}

function sumActiveTrades(trades: BrokerActiveSignalTrade[]) {
  return {
    channelCount: trades.length,
    totalLots: trades.reduce((sum, row) => sum + row.totalLots, 0),
    pnl: trades.reduce((sum, row) => sum + row.pnl, 0),
    positionCount: trades.reduce((sum, row) => sum + row.positionCount, 0),
  }
}

function sumPortfolioGroups(groups: PortfolioBrokerActiveSignals[]) {
  const trades = groups.flatMap(group => group.activeSignalTrades)
  const totals = sumActiveTrades(trades)
  return {
    ...totals,
    accountCount: groups.length,
    pnl: groups.reduce((sum, group) => sum + (group.brokerOpenPnl ?? 0), 0) || totals.pnl,
  }
}

export function useForceCloseSignalTrades(opts?: {
  onRefresh?: () => void | Promise<void>
}) {
  const t = useT()
  const bs = t.dashboard.brokerStats

  const [closingChannelKey, setClosingChannelKey] = useState<string | null>(null)
  const [closingBrokerId, setClosingBrokerId] = useState<string | null>(null)
  const [closingAllBrokers, setClosingAllBrokers] = useState(false)
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const [pendingConfirm, setPendingConfirm] = useState<ForceCloseConfirmRequest | null>(null)
  const [confirmingClose, setConfirmingClose] = useState(false)

  const actionInProgress = closingChannelKey != null || closingBrokerId != null || closingAllBrokers || confirmingClose
  const closeBusy = actionInProgress || pendingConfirm != null

  const showToast = useCallback((message: string) => {
    setToastMessage(message)
    window.setTimeout(() => setToastMessage(null), 4500)
  }, [])

  const handleCloseResult = useCallback(async (result: { closed: number; failed: number }) => {
    if (result.closed > 0 && result.failed === 0) {
      showToast(interpolate(bs.closeSuccess, { count: String(result.closed) }))
    } else if (result.closed > 0 && result.failed > 0) {
      showToast(interpolate(bs.closePartial, {
        closed: String(result.closed),
        total: String(result.closed + result.failed),
      }))
    } else {
      showToast(bs.closeFailed)
    }
    if (result.closed > 0) {
      await opts?.onRefresh?.()
    }
  }, [bs, opts, showToast])

  const dismissCloseConfirm = useCallback(() => {
    if (confirmingClose) return
    setPendingConfirm(null)
  }, [confirmingClose])

  const executeChannelClose = useCallback(async (brokerId: string, channelId: string) => {
    setClosingChannelKey(channelCloseKey(brokerId, channelId))
    try {
      const result = await forceCloseTradesApi.close({
        broker_account_id: brokerId,
        channel_id: channelId,
      })
      await handleCloseResult(result)
    } catch (err) {
      showToast(err instanceof Error ? err.message : bs.closeFailed)
    } finally {
      setClosingChannelKey(null)
    }
  }, [bs, handleCloseResult, showToast])

  const executeBrokerClose = useCallback(async (brokerId: string) => {
    setClosingBrokerId(brokerId)
    try {
      const result = await forceCloseTradesApi.close({ broker_account_id: brokerId })
      await handleCloseResult(result)
    } catch (err) {
      showToast(err instanceof Error ? err.message : bs.closeFailed)
    } finally {
      setClosingBrokerId(null)
    }
  }, [bs, handleCloseResult, showToast])

  const executeAllBrokersClose = useCallback(async (brokerIds: string[]) => {
    setClosingAllBrokers(true)
    try {
      let closed = 0
      let failed = 0
      for (const brokerId of brokerIds) {
        const result = await forceCloseTradesApi.close({ broker_account_id: brokerId })
        closed += result.closed
        failed += result.failed
      }
      await handleCloseResult({ closed, failed })
    } catch (err) {
      showToast(err instanceof Error ? err.message : bs.closeFailed)
    } finally {
      setClosingAllBrokers(false)
    }
  }, [bs, handleCloseResult, showToast])

  const confirmPendingClose = useCallback(async () => {
    if (!pendingConfirm || actionInProgress) return
    const request = pendingConfirm
    setConfirmingClose(true)
    try {
      if (request.scope === 'channel' && request.brokerId && request.channelId) {
        await executeChannelClose(request.brokerId, request.channelId)
      } else if (request.scope === 'broker' && request.brokerId) {
        await executeBrokerClose(request.brokerId)
      } else if (request.scope === 'all' && request.brokerIds) {
        await executeAllBrokersClose(request.brokerIds)
      }
    } finally {
      setConfirmingClose(false)
      setPendingConfirm(null)
    }
  }, [actionInProgress, executeAllBrokersClose, executeBrokerClose, executeChannelClose, pendingConfirm])

  const closeChannel = useCallback((
    brokerId: string,
    channelId: string,
    detail: {
      channelLabel: string
      accountLabel?: string
      totalLots?: number
      pnl?: number
      positionCount?: number
    },
  ) => {
    if (closeBusy) return
    setPendingConfirm({
      scope: 'channel',
      brokerId,
      channelId,
      channelLabel: detail.channelLabel,
      accountLabel: detail.accountLabel,
      channelCount: 1,
      totalLots: detail.totalLots ?? 0,
      pnl: detail.pnl ?? 0,
      positionCount: detail.positionCount ?? 0,
      accountCount: 1,
    })
  }, [closeBusy])

  const closeBroker = useCallback((
    brokerId: string,
    detail?: {
      accountLabel?: string
      activeSignalTrades?: BrokerActiveSignalTrade[]
    },
  ) => {
    if (closeBusy) return
    const totals = sumActiveTrades(detail?.activeSignalTrades ?? [])
    setPendingConfirm({
      scope: 'broker',
      brokerId,
      channelLabel: detail?.activeSignalTrades?.[0]?.channelLabel ?? '',
      accountLabel: detail?.accountLabel,
      ...totals,
      accountCount: 1,
    })
  }, [closeBusy])

  const closeAllBrokers = useCallback((
    brokerIds: string[],
    detail?: {
      groups?: PortfolioBrokerActiveSignals[]
    },
  ) => {
    if (closeBusy || brokerIds.length === 0) return
    const totals = detail?.groups ? sumPortfolioGroups(detail.groups) : {
      channelCount: 0,
      totalLots: 0,
      pnl: 0,
      positionCount: 0,
      accountCount: brokerIds.length,
    }
    setPendingConfirm({
      scope: 'all',
      brokerIds,
      channelLabel: '',
      ...totals,
      accountCount: totals.accountCount || brokerIds.length,
    })
  }, [closeBusy])

  return {
    bs,
    closingChannelKey,
    closingBrokerId,
    closingAllBrokers,
    closeBusy,
    toastMessage,
    pendingConfirm,
    confirmingClose,
    dismissCloseConfirm,
    confirmPendingClose,
    closeChannel,
    closeBroker,
    closeAllBrokers,
    isClosingChannel: (brokerId: string, channelId: string) =>
      closingChannelKey === channelCloseKey(brokerId, channelId),
    isClosingBroker: (brokerId: string) => closingBrokerId === brokerId,
  }
}

import { useCallback, useEffect, useState } from 'react'
import { fxsocketBroker } from '../lib/fxsocketBroker'
import type { BrokerAccount } from '../types/database'

export function useFxsocketBrokers(enabled = true) {
  const [accounts, setAccounts] = useState<BrokerAccount[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!enabled) return
    setLoading(true)
    setError(null)
    try {
      const rows = await fxsocketBroker.list()
      setAccounts(rows)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load broker accounts')
    } finally {
      setLoading(false)
    }
  }, [enabled])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { accounts, loading, error, refresh, setAccounts }
}

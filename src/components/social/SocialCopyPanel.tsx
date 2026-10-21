import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useBrokerAccounts } from '../../context/BrokerAccountsContext'
import { supabase } from '../../lib/supabase'
import {
  changeSocialCopySubscription,
  createSocialCopySubscription,
  fetchSocialCopySources,
  fetchSocialCopySubscriptions,
  publishSocialCopySource,
  type SocialCopySource,
  type SocialCopySubscription,
} from '../../lib/socialCopy'
import { Alert } from '../ui/Alert'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'

function accountMode(value: string | null | undefined): 'demo' | 'live' {
  return ['demo', 'practice'].includes(String(value ?? '').toLowerCase()) ? 'demo' : 'live'
}

function accountLabel(account: { label?: string | null; platform?: string | null; account_login?: string | null }): string {
  return account.label || `${account.platform ?? 'Broker'}${account.account_login ? ` · ${account.account_login}` : ''}`
}

function statusLabel(subscription: SocialCopySubscription): string {
  if (subscription.status === 'pending') return 'Pending worker acknowledgement'
  if (subscription.status === 'active') return 'Active'
  if (subscription.status === 'paused') return 'Paused'
  if (subscription.status === 'stopped') return 'Stopped'
  if (subscription.status === 'emergency_stopped') return 'Emergency stopped'
  return `Error${subscription.errorCode ? ` · ${subscription.errorCode}` : ''}`
}

function eligibilityMessage(reason: string): string {
  const messages: Record<string, string> = {
    synthetic_demo: 'This is synthetic DEMO data and can never be copied.',
    source_missing: 'The published source account is missing.',
    source_not_published: 'The provider has not published this source.',
    source_unsupported: 'Performance verification is not supported for this broker connection.',
    account_mode_unknown: 'Reconnect the source so its demo/live mode can be verified.',
    demo_only: 'Phase 1 copy eligibility is limited to demo source accounts.',
    source_inactive: 'The provider must activate the source account.',
    sync_failed: 'The source synchronization failed. The provider must reconnect it.',
    source_disconnected: 'The provider source is disconnected.',
    sync_pending: 'Waiting for the first successful source synchronization.',
    history_stale: 'Source data is stale. The provider must restore synchronization.',
    history_incomplete: 'Some closed trades are still missing verified broker results.',
    minimum_trades_not_met: 'At least 10 complete closed trades are required.',
    minimum_period_not_met: 'Closed-trade history must span at least 7 days.',
  }
  return messages[reason] ?? 'This provider does not currently meet copy eligibility requirements.'
}

export function SocialCopyPanel({ traderUserId, isSelf }: { traderUserId: string; isSelf: boolean }) {
  const { brokers } = useBrokerAccounts()
  const [sources, setSources] = useState<SocialCopySource[]>([])
  const [subscriptions, setSubscriptions] = useState<SocialCopySubscription[]>([])
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [sourceId, setSourceId] = useState('')
  const [destinationId, setDestinationId] = useState('')
  const [sizingMode, setSizingMode] = useState<'fixed_lot' | 'lot_multiplier' | 'equity_ratio'>('fixed_lot')
  const [fixedLot, setFixedLot] = useState('0.01')
  const [multiplier, setMultiplier] = useState('1')
  const [maxLot, setMaxLot] = useState('0.10')
  const [confirmed, setConfirmed] = useState(false)
  const generation = useRef(0)

  const refresh = useCallback(async (quiet = false) => {
    const request = ++generation.current
    if (!quiet) setLoading(true)
    try {
      const nextSources = await fetchSocialCopySources(supabase, traderUserId)
      const nextSubscriptions = isSelf ? [] : await fetchSocialCopySubscriptions(supabase, traderUserId)
      if (request !== generation.current) return
      setSources(nextSources)
      setSubscriptions(nextSubscriptions)
      setSourceId(current => nextSources.some(source => source.sourceId === current) ? current : (nextSources[0]?.sourceId ?? ''))
      setError(null)
    } catch (cause) {
      if (request === generation.current) setError(cause instanceof Error ? cause.message : 'Unable to load copy trading')
    } finally {
      if (request === generation.current) setLoading(false)
    }
  }, [isSelf, traderUserId])

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0)
    return () => {
      window.clearTimeout(timer)
      generation.current += 1
    }
  }, [refresh])

  useEffect(() => {
    if (isSelf || !subscriptions.some(item => item.status === 'pending' || item.status === 'active')) return
    const timer = window.setInterval(() => void refresh(true), 5_000)
    return () => window.clearInterval(timer)
  }, [isSelf, refresh, subscriptions])

  const destinations = useMemo(() => brokers.filter(broker => broker.is_active), [brokers])
  const selectedDestination = destinations.find(broker => broker.id === destinationId) ?? destinations[0] ?? null
  const selectedSource = sources.find(source => source.sourceId === sourceId) ?? sources[0] ?? null
  const selectedExecutionMode: 'demo' | 'live' = selectedSource?.accountMode === 'live'
    || (selectedDestination && accountMode(selectedDestination.linked_account_type) === 'live') ? 'live' : 'demo'

  const fixedLotNumber = Number(fixedLot)
  const multiplierNumber = Number(multiplier)
  const maxLotNumber = Number(maxLot)
  const configurationValid = Number.isFinite(maxLotNumber) && maxLotNumber > 0 && maxLotNumber <= 1000
    && (sizingMode !== 'fixed_lot' || (Number.isFinite(fixedLotNumber) && fixedLotNumber > 0 && fixedLotNumber <= maxLotNumber))
    && (sizingMode === 'fixed_lot' || (Number.isFinite(multiplierNumber) && multiplierNumber > 0 && multiplierNumber <= 100))


  async function run(key: string, action: () => Promise<void>, success: string) {
    if (pending) return
    setPending(key)
    setError(null)
    setNotice(null)
    try {
      await action()
      await refresh(true)
      setNotice(success)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Copy trading request failed')
      await refresh(true).catch(() => undefined)
    } finally {
      setPending(null)
    }
  }

  if (loading) return <Card><p className="text-sm text-neutral-500">Loading copy availability…</p></Card>

  if (isSelf) {
    return (
      <Card>
        <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">Publish a copy source</h2>
        <p className="mt-1 text-sm text-neutral-500">Publishing is explicit. It exposes availability and platform details, never credentials, login secrets, balances, or trades.</p>
        {error ? <div className="mt-3"><Alert variant="error">{error}</Alert></div> : null}
        {notice ? <div className="mt-3"><Alert variant="success">{notice}</Alert></div> : null}
        {brokers.length === 0 ? <p className="mt-3 text-sm text-neutral-500">Connect a broker account before publishing a source.</p> : (
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <label className="text-xs text-neutral-500">Broker account
              <select className="mt-1 block rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900" value={destinationId || brokers[0]?.id} onChange={event => setDestinationId(event.target.value)}>
                {brokers.map(broker => <option key={broker.id} value={broker.id}>{accountLabel(broker)} · {accountMode(broker.linked_account_type)}</option>)}
              </select>
            </label>
            <Button type="button" size="sm" disabled={Boolean(pending)} onClick={() => {
              const id = destinationId || brokers[0]?.id
              if (id) void run('publish', () => publishSocialCopySource(supabase, id, accountLabel(brokers.find(item => item.id === id) ?? brokers[0]!)).then(() => undefined), 'Copy source published.')
            }}>Publish source</Button>
          </div>
        )}
        {sources.length > 0 ? <p className="mt-3 text-xs text-neutral-500">Published sources: {sources.map(source => `${source.label} (${source.accountMode})`).join(', ')}</p> : null}
      </Card>
    )
  }

  return (
    <Card>
      <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">Copy this trader</h2>
      <p className="mt-1 text-sm text-neutral-500">Performance unavailable. Configure copying only from a source the trader explicitly published. Following alone never starts trading.</p>
      <p className="mt-1 text-xs text-neutral-500">Paid copy subscriptions are unavailable; no payment or entitlement is implied.</p>
      {error ? <div className="mt-3"><Alert variant="error">{error}</Alert></div> : null}
      {notice ? <div className="mt-3"><Alert variant="success">{notice}</Alert></div> : null}

      {sources.length === 0 ? <p className="mt-4 text-sm text-neutral-500">No eligible copy source is available. A private trader also requires an accepted follow.</p> : (
        <div className="mt-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-neutral-500">Published source
              <select className="mt-1 block w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900" value={sourceId} onChange={event => setSourceId(event.target.value)}>
                {sources.map(source => <option key={source.sourceId} value={source.sourceId}>{source.label} · {source.platform} · {source.isSynthetic ? 'DEMO DATA · ' : ''}{source.accountMode} · {source.isCopyEligible ? 'eligible' : 'not eligible'}</option>)}
              </select>
            </label>
            <label className="text-xs text-neutral-500">Destination account
              <select className="mt-1 block w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900" value={destinationId || destinations[0]?.id || ''} onChange={event => setDestinationId(event.target.value)}>
                <option value="" disabled>Select an account</option>
                {destinations.map(broker => <option key={broker.id} value={broker.id}>{accountLabel(broker)} · {accountMode(broker.linked_account_type)}</option>)}
              </select>
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-xs text-neutral-500">Sizing
              <select className="mt-1 block w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900" value={sizingMode} onChange={event => setSizingMode(event.target.value as typeof sizingMode)}>
                <option value="fixed_lot">Fixed lot</option><option value="lot_multiplier">Source lot multiplier</option><option value="equity_ratio">Equity proportional</option>
              </select>
            </label>
            <label className="text-xs text-neutral-500">{sizingMode === 'fixed_lot' ? 'Fixed lot' : 'Multiplier'}
              <input type="number" min="0.01" step="0.01" className="mt-1 block w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900" value={sizingMode === 'fixed_lot' ? fixedLot : multiplier} onChange={event => sizingMode === 'fixed_lot' ? setFixedLot(event.target.value) : setMultiplier(event.target.value)} />
            </label>
            <label className="text-xs text-neutral-500">Maximum lot
              <input type="number" min="0.01" step="0.01" className="mt-1 block w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900" value={maxLot} onChange={event => setMaxLot(event.target.value)} />
            </label>
          </div>
          {selectedSource?.isSynthetic ? <Alert variant="warning">DEMO DATA: synthetic performance is display-only and cannot create or authorize copy subscriptions.</Alert> : null}
          {selectedSource && !selectedSource.isCopyEligible ? (
            <Alert variant="warning">Provider not eligible for copying: {eligibilityMessage(selectedSource.eligibilityReason)}</Alert>
          ) : null}
          <label className="flex gap-2 text-xs text-neutral-600 dark:text-neutral-300">
            <input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
            I understand this persists a {selectedExecutionMode} subscription and can place real broker orders only after the worker acknowledges it.
          </label>
          {!configurationValid ? <p className="text-xs text-red-600 dark:text-red-400">Enter positive sizing values; fixed lot cannot exceed maximum lot.</p> : null}
          <Button type="button" size="sm" disabled={Boolean(pending) || !confirmed || !configurationValid || !selectedSource?.connectionHealthy || !selectedSource?.isCopyEligible || !selectedDestination} onClick={() => {
            if (!selectedSource || !selectedDestination) return
            void run('create', () => createSocialCopySubscription(supabase, {
              sourceId: selectedSource.sourceId, destinationBrokerAccountId: selectedDestination.id,
              sizingMode, fixedLot: fixedLotNumber, lotMultiplier: multiplierNumber, maxLot: maxLotNumber,
              accountMode: selectedExecutionMode,
            }).then(() => undefined), 'Subscription saved. Waiting for worker acknowledgement.')
          }}>Confirm subscription</Button>
        </div>
      )}

      {subscriptions.length > 0 ? <div className="mt-5 space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Persisted subscriptions</h3>
        {subscriptions.map(subscription => <div key={subscription.id} className="rounded-lg border border-neutral-200 p-3 text-sm dark:border-neutral-700">
          <div className="flex flex-wrap items-center justify-between gap-2"><span>{statusLabel(subscription)}</span><span className="text-xs text-neutral-500">{subscription.sizingMode} · max {subscription.maxLot}</span></div>
          {subscription.errorDetail ? <p className="mt-1 text-xs text-red-600 dark:text-red-400">{subscription.errorDetail}</p> : null}
          {!['stopped', 'emergency_stopped'].includes(subscription.status) ? <div className="mt-2 flex flex-wrap gap-2">
            {subscription.status === 'paused' || subscription.status === 'error' ? <Button size="sm" type="button" disabled={Boolean(pending)} onClick={() => void run(subscription.id, () => changeSocialCopySubscription(supabase, subscription.id, 'resume'), 'Resume requested.')}>Retry / resume</Button> : <Button size="sm" type="button" variant="secondary" disabled={Boolean(pending)} onClick={() => void run(subscription.id, () => changeSocialCopySubscription(supabase, subscription.id, 'pause'), 'Pause requested.')}>Pause</Button>}
            <Button size="sm" type="button" variant="secondary" disabled={Boolean(pending)} onClick={() => void run(subscription.id, () => changeSocialCopySubscription(supabase, subscription.id, 'stop'), 'Stop requested.')}>Stop and close copies</Button>
            <Button size="sm" type="button" variant="secondary" disabled={Boolean(pending)} onClick={() => void run(subscription.id, () => changeSocialCopySubscription(supabase, subscription.id, 'emergency_stop'), 'Emergency stop requested.')}>Emergency stop</Button>
          </div> : null}
        </div>)}
      </div> : null}
    </Card>
  )
}

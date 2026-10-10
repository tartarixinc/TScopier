import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { useT } from '../../context/LocaleContext'
import { useSubscription } from '../../context/SubscriptionContext'
import { interpolate } from '../../i18n/interpolate'
import {
  brokersMatchingChannel,
  brokersNotMatchingChannel,
  connectChannelToBroker,
  disconnectChannelFromBroker,
  getBrokerDisplayLabel,
  linkChannelToAllActiveBrokers,
} from '../../lib/brokerChannelLink'
import { isBrokerCopyEnabledForUi } from '../../lib/brokerLink'
import { planLimitErrorMessage } from '../../lib/telegramChannelApi'
import {
  addWhatsAppGroup,
  fetchWhatsAppGroups,
  fetchWhatsAppStatus,
  logoutWhatsApp,
  pairWhatsApp,
  removeWhatsAppGroup,
  setWhatsAppGroupActive,
  subscribeWhatsAppSourcesChanged,
  type WhatsAppSessionStatus,
} from '../../lib/whatsappSource'
import { whatsappListenerBaseUrl } from '../../lib/whatsappGroup'
import type { BrokerAccount } from '../../types/database'
import { Card } from '../ui/Card'
import { Button } from '../ui/Button'
import { Toggle } from '../ui/Toggle'
import { Badge } from '../ui/Badge'

type SelectedGroup = {
  id: string
  group_jid: string
  name: string
  channel_id: string
  is_active: boolean
}

type AvailableGroup = { group_jid: string; name: string }

export function WhatsAppSourcePanel({
  brokers,
  replaceBroker,
}: {
  brokers: BrokerAccount[]
  replaceBroker: (broker: BrokerAccount) => void
}) {
  const { user } = useAuth()
  const t = useT()
  const copy = t.channelsPage
  const ce = t.copierEnginePage
  const { canAddChannel, limits, refresh: refreshSubscription } = useSubscription()
  const [sessionStatus, setSessionStatus] = useState<WhatsAppSessionStatus | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [groups, setGroups] = useState<SelectedGroup[]>([])
  const [available, setAvailable] = useState<AvailableGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [pairing, setPairing] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [connectMenuId, setConnectMenuId] = useState<string | null>(null)
  const [connectingBrokerId, setConnectingBrokerId] = useState<string | null>(null)
  const [connectingAllId, setConnectingAllId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const loadSelected = useCallback(async () => {
    if (!user?.id) {
      setGroups([])
      setSessionStatus(null)
      setLoading(false)
      return
    }
    const [groupRes, sessionRes] = await Promise.all([
      supabase.from('whatsapp_groups').select('id, group_jid, name, channel_id, is_active').eq('user_id', user.id).order('created_at', { ascending: true }),
      supabase.from('whatsapp_sessions').select('status').eq('user_id', user.id).maybeSingle(),
    ])
    if (groupRes.error) setError(groupRes.error.message)
    setGroups((groupRes.data ?? []) as SelectedGroup[])
    let status = (sessionRes.data as { status?: WhatsAppSessionStatus } | null)?.status ?? 'disconnected'
    if (status !== 'connected' && whatsappListenerBaseUrl()) {
      const live = await fetchWhatsAppStatus(supabase)
      if (!live.error && (live.status === 'connected' || live.status === 'qr')) {
        status = live.status
        setQr(live.qr)
      }
    }
    setSessionStatus(status)
    setLoading(false)
  }, [user?.id])

  const refreshGroups = useCallback(async () => {
    const result = await fetchWhatsAppGroups(supabase)
    if (result.error && result.error !== 'not_connected') setError(result.error)
    else setAvailable(result.groups)
  }, [])

  useEffect(() => {
    void loadSelected()
    return subscribeWhatsAppSourcesChanged(() => { void loadSelected() })
  }, [loadSelected])

  useEffect(() => {
    if (sessionStatus !== 'connected') return
    void refreshGroups()
  }, [refreshGroups, sessionStatus])

  useEffect(() => {
    if (sessionStatus !== 'qr') return
    const timer = window.setInterval(() => {
      void fetchWhatsAppStatus(supabase).then(result => {
        if (result.error) return
        setQr(result.qr)
        if (result.status) setSessionStatus(result.status)
      })
    }, 2000)
    return () => window.clearInterval(timer)
  }, [sessionStatus])

  const selectedJids = useMemo(() => new Set(groups.map(group => group.group_jid)), [groups])
  const unselected = available.filter(group => !selectedJids.has(group.group_jid))

  const connect = async () => {
    if (!whatsappListenerBaseUrl()) {
      setError(copy.whatsappListenerMissing)
      return
    }
    setPairing(true)
    setError('')
    const result = await pairWhatsApp(supabase)
    setPairing(false)
    if (result.error) {
      const live = await fetchWhatsAppStatus(supabase)
      if (!live.error && live.status === 'connected') {
        setSessionStatus('connected')
        return
      }
      if (!live.error && live.qr) {
        setQr(live.qr)
        setSessionStatus('qr')
        return
      }
      setError(result.error === 'listener_missing' ? copy.whatsappListenerMissing : result.error)
      return
    }
    setQr(result.qr)
    if (result.status) setSessionStatus(result.status)
  }

  const disconnect = async () => {
    setError('')
    const result = await logoutWhatsApp(supabase)
    if (result.error) setError(result.error)
    setQr(null)
    setSessionStatus('disconnected')
    setAvailable([])
    await loadSelected()
  }

  const addGroup = async (group: AvailableGroup) => {
    if (!user?.id) return
    if (!canAddChannel()) {
      setError(interpolate(t.pricing.paywall.channelLimit, { limit: String(limits.maxTelegramChannels ?? 5) }))
      return
    }
    setBusyId(group.group_jid)
    setError('')
    const result = await addWhatsAppGroup(supabase, user.id, group.group_jid, group.name)
    setBusyId(null)
    if (result.error) {
      setError(planLimitErrorMessage(result.error))
      return
    }
    void refreshSubscription()
    await loadSelected()
  }

  if (loading && sessionStatus === null) {
    return <Card><p className="py-8 text-center text-sm text-neutral-500 dark:text-neutral-400">{t.common.loading}</p></Card>
  }

  if (sessionStatus !== 'connected') {
    const steps = [copy.whatsappHow1, copy.whatsappHow2, copy.whatsappHow3]
    return (
      <Card className="overflow-hidden" padding="none">
        <div className="relative border-b border-neutral-100 bg-gradient-to-br from-neutral-200/80 via-neutral-50 to-white px-5 pb-5 pt-6 dark:border-neutral-800 dark:from-[#2a2e39] dark:via-[#1e222d] dark:to-neutral-950 sm:px-6 sm:pt-7">
          <div className="mx-auto flex max-w-md flex-col items-center text-center">
            <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl border border-neutral-100 bg-white shadow-md dark:border-neutral-700 dark:bg-neutral-800">
              <img src="/whatsapp-icon.png" alt="" className="h-10 w-10 rounded-full object-cover" loading="lazy" aria-hidden />
            </div>
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">{copy.whatsappHeroTitle}</h2>
            <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">{copy.whatsappHeroSubtitle}</p>
          </div>
        </div>
        <div className="mx-auto max-w-md px-5 py-5 sm:px-6 sm:py-6">
          {qr ? (
            <div className="mb-5 flex flex-col items-center gap-3">
              <div className="rounded-xl bg-white p-3">
                <QRCodeSVG value={qr} size={196} />
              </div>
              <p className="text-center text-sm text-neutral-600 dark:text-neutral-300">{copy.whatsappQrHelp}</p>
            </div>
          ) : sessionStatus === 'qr' ? (
            <p className="mb-5 text-center text-sm text-neutral-600 dark:text-neutral-300">{t.common.loading}</p>
          ) : (
            <ul className="mb-5 space-y-2.5">
              {steps.map((line, index) => (
                <li key={line} className="flex items-start gap-2.5 text-sm text-neutral-600 dark:text-neutral-300">
                  <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-primary-100 text-xs font-semibold text-primary-700 dark:bg-primary-900/50 dark:text-primary-300">
                    {index + 1}
                  </span>
                  {line}
                </li>
              ))}
            </ul>
          )}
          {error ? <p className="mb-4 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
          <Button size="lg" className="w-full" loading={pairing} onClick={() => void connect()}>
            <img src="/whatsapp-icon.png" alt="" className="h-5 w-5 rounded-full object-cover" loading="lazy" aria-hidden />
            {copy.whatsappConnect}
          </Button>
        </div>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <Card padding="none">
        <div className="flex items-center justify-between gap-3 border-b border-neutral-100 px-4 py-3 dark:border-neutral-800">
          <div>
            <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{copy.whatsappListTitle}</h2>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">{interpolate(ce.configuredCount, { count: String(groups.length) })}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              loading={refreshing}
              onClick={() => {
                setRefreshing(true)
                void refreshGroups().finally(() => setRefreshing(false))
              }}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {copy.whatsappRefresh}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void disconnect()}>
              {copy.whatsappDisconnect}
            </Button>
          </div>
        </div>
        {error ? <p className="px-4 pt-3 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
        {groups.length === 0 ? (
          <p className="px-4 py-6 text-sm text-neutral-500 dark:text-neutral-400">{copy.whatsappEmptyGroups}</p>
        ) : (
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {groups.map(group => (
              <WhatsAppGroupRow
                key={group.id}
                group={group}
                brokers={brokers}
                menuOpen={connectMenuId === group.id}
                connectingBrokerId={connectingBrokerId}
                connectingAll={connectingAllId === group.id}
                deleting={busyId === group.id}
                onToggleMenu={() => setConnectMenuId(current => current === group.id ? null : group.id)}
                onCloseMenu={() => setConnectMenuId(null)}
                onConnectBroker={async brokerId => {
                  const broker = brokers.find(item => item.id === brokerId)
                  if (!broker || !user?.id) return
                  setConnectingBrokerId(brokerId)
                  const result = await connectChannelToBroker(supabase, user.id, broker, group.channel_id)
                  setConnectingBrokerId(null)
                  setConnectMenuId(null)
                  if (result.error) setError(result.error)
                  else if (result.broker) replaceBroker(result.broker)
                }}
                onConnectAll={async () => {
                  if (!user?.id) return
                  setConnectingAllId(group.id)
                  const result = await linkChannelToAllActiveBrokers(supabase, user.id, group.channel_id, brokers)
                  setConnectingAllId(null)
                  if (result.error) setError(result.error)
                  for (const broker of result.brokers) replaceBroker(broker)
                }}
                onDisconnect={async brokerId => {
                  const broker = brokers.find(item => item.id === brokerId)
                  if (!broker || !user?.id) return
                  const result = await disconnectChannelFromBroker(supabase, user.id, broker, group.channel_id)
                  if (result.error) setError(result.error)
                  else if (result.broker) replaceBroker(result.broker)
                }}
                onToggle={async active => {
                  if (!user?.id) return
                  const result = await setWhatsAppGroupActive(supabase, user.id, group.id, group.channel_id, active)
                  if (result.error) setError(result.error)
                  else {
                    setGroups(current => current.map(row => row.id === group.id ? { ...row, is_active: active } : row))
                    void refreshSubscription()
                  }
                }}
                onDelete={async () => {
                  if (!user?.id) return
                  setBusyId(group.id)
                  const result = await removeWhatsAppGroup(supabase, user.id, group.channel_id, brokers)
                  setBusyId(null)
                  if (result.error) setError(result.error)
                  else {
                    for (const broker of result.brokers) replaceBroker(broker)
                    void refreshSubscription()
                    await loadSelected()
                  }
                }}
              />
            ))}
          </ul>
        )}
      </Card>

      <Card padding="none">
        <div className="border-b border-neutral-100 px-4 py-3 dark:border-neutral-800">
          <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{copy.whatsappPickGroups}</h2>
        </div>
        {unselected.length === 0 ? (
          <p className="px-4 py-6 text-sm text-neutral-500 dark:text-neutral-400">{copy.whatsappNoGroups}</p>
        ) : (
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {unselected.map(group => (
              <li key={group.group_jid} className="flex items-center gap-3 px-4 py-3">
                <img src="/whatsapp-icon.png" alt="" aria-hidden className="h-8 w-8 shrink-0 rounded-full object-cover" />
                <p className="min-w-0 flex-1 truncate text-sm font-semibold text-neutral-900 dark:text-neutral-50">{group.name}</p>
                <Button size="sm" variant="secondary" loading={busyId === group.group_jid} onClick={() => void addGroup(group)}>
                  {copy.whatsappAdd}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

function WhatsAppGroupRow({
  group,
  brokers,
  menuOpen,
  connectingBrokerId,
  connectingAll,
  deleting,
  onToggleMenu,
  onCloseMenu,
  onConnectBroker,
  onConnectAll,
  onDisconnect,
  onToggle,
  onDelete,
}: {
  group: SelectedGroup
  brokers: BrokerAccount[]
  menuOpen: boolean
  connectingBrokerId: string | null
  connectingAll: boolean
  deleting: boolean
  onToggleMenu: () => void
  onCloseMenu: () => void
  onConnectBroker: (brokerId: string) => void
  onConnectAll: () => void
  onDisconnect: (brokerId: string) => void
  onToggle: (active: boolean) => void
  onDelete: () => void
}) {
  const t = useT()
  const ce = t.copierEnginePage
  const menuRef = useRef<HTMLDivElement>(null)
  const connected = useMemo(() => brokersMatchingChannel(brokers, group.channel_id), [brokers, group.channel_id])
  const availableBrokers = useMemo(() => brokersNotMatchingChannel(brokers, group.channel_id), [brokers, group.channel_id])
  const hasAnyBrokers = brokers.some(broker => isBrokerCopyEnabledForUi(broker))

  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) onCloseMenu()
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [menuOpen, onCloseMenu])

  return (
    <li className={clsx(menuOpen && 'relative z-20')}>
      <div className="flex items-center gap-3 px-4 py-3">
        <img src="/whatsapp-icon.png" alt="" aria-hidden className="h-8 w-8 shrink-0 rounded-full object-cover" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-50">{group.name}</h3>
            {!group.is_active ? <Badge variant="neutral" size="sm">{ce.statusPaused}</Badge> : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Toggle checked={group.is_active} onChange={onToggle} />
          <button
            type="button"
            onClick={onDelete}
            disabled={deleting}
            className="rounded-lg p-1.5 text-neutral-400 transition-colors hover:bg-error-50 hover:text-error-600 disabled:opacity-50"
            aria-label={interpolate(ce.removeAria, { label: group.name })}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="space-y-2.5 border-t border-neutral-100 bg-neutral-50 px-4 py-2.5 dark:border-neutral-800 dark:bg-neutral-800/60">
        <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">{ce.connectedBrokers}</p>
        {connected.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {connected.map(broker => {
              const label = getBrokerDisplayLabel(broker)
              return (
                <Badge key={broker.id} variant="neutral" size="sm">
                  <span>{label}</span>
                  <button
                    type="button"
                    onClick={() => onDisconnect(broker.id)}
                    className="-mr-0.5 ml-0.5 rounded-full p-0.5 text-neutral-400 transition-colors hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-700 dark:hover:text-neutral-100"
                    aria-label={interpolate(ce.removeBrokerConnectionAria, { broker: label, channel: group.name })}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              )
            })}
            <div className="relative" ref={menuRef}>
              <button
                type="button"
                onClick={onToggleMenu}
                className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-neutral-200 text-neutral-500 transition-colors hover:bg-white hover:text-neutral-800 dark:border-neutral-700 dark:hover:bg-neutral-900 dark:hover:text-neutral-100"
                aria-label={interpolate(ce.addBrokerConnectionAria, { channel: group.name })}
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
              {menuOpen ? (
                <BrokerMenu brokers={availableBrokers} connectingBrokerId={connectingBrokerId} onConnect={onConnectBroker} onClose={onCloseMenu} />
              ) : null}
            </div>
          </div>
        ) : hasAnyBrokers ? (
          <div className="flex flex-wrap items-center gap-2">
            {availableBrokers.length >= 2 ? (
              <Button type="button" variant="secondary" size="sm" loading={connectingAll} onClick={onConnectAll}>
                {ce.connectAllBrokers}
              </Button>
            ) : null}
            <div className="relative inline-block" ref={menuRef}>
              <Button type="button" variant="secondary" size="sm" onClick={onToggleMenu} loading={connectingBrokerId !== null && !connectingAll}>
                {ce.connectToBroker}
              </Button>
              {menuOpen && availableBrokers.length > 0 ? (
                <BrokerMenu brokers={availableBrokers} connectingBrokerId={connectingBrokerId} onConnect={onConnectBroker} onClose={onCloseMenu} />
              ) : null}
            </div>
          </div>
        ) : (
          <Link
            to="/brokers"
            className="inline-flex items-center rounded-lg border border-dashed border-neutral-300 px-3 py-1.5 text-xs font-medium text-primary-600 transition-colors hover:bg-white dark:border-neutral-600 dark:hover:bg-neutral-900"
          >
            {ce.connectToBroker}
          </Link>
        )}
      </div>
    </li>
  )
}

function BrokerMenu({
  brokers,
  connectingBrokerId,
  onConnect,
  onClose,
}: {
  brokers: BrokerAccount[]
  connectingBrokerId: string | null
  onConnect: (brokerId: string) => void
  onClose: () => void
}) {
  const ce = useT().copierEnginePage
  return (
    <div className="absolute left-0 top-full z-30 mt-1 min-w-[12rem] rounded-lg border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
      {brokers.length === 0 ? (
        <p className="px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400">{ce.connectedBrokers}</p>
      ) : brokers.map(broker => (
        <button
          key={broker.id}
          type="button"
          disabled={connectingBrokerId === broker.id}
          onClick={() => onConnect(broker.id)}
          className="w-full px-3 py-2 text-left text-sm text-neutral-800 hover:bg-neutral-50 disabled:opacity-50 dark:text-neutral-100 dark:hover:bg-neutral-800"
        >
          {getBrokerDisplayLabel(broker)}
        </button>
      ))}
      <div className="mt-1 border-t border-neutral-100 pt-1 dark:border-neutral-800">
        <Link to="/brokers" className="block px-3 py-2 text-xs text-primary-600 hover:bg-neutral-50 dark:hover:bg-neutral-800" onClick={onClose}>
          {ce.connectBrokerInConfig}
        </Link>
      </div>
    </div>
  )
}

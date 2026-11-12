import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { Copy, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { useConfirm } from '../../context/ConfirmDialogContext'
import { useT } from '../../context/LocaleContext'
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
import {
  TRADINGVIEW_TP_COUNT_MAX,
  TRADINGVIEW_TP_COUNT_MIN,
  buildTradingViewAlertTemplates,
  normalizeTradingViewAlertConfig,
  type TradingViewAlertConfig,
} from '../../lib/tradingViewAlertTemplate'
import {
  createTradingViewWebhook,
  deleteTradingViewWebhook,
  rotateTradingViewWebhook,
  setTradingViewWebhookActive,
  updateTradingViewAlertConfig,
} from '../../lib/tradingViewWebhook'
import type { BrokerAccount, TradingViewWebhook, TradingViewWebhookDelivery } from '../../types/database'
import { Card } from '../ui/Card'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Toggle } from '../ui/Toggle'
import { Badge } from '../ui/Badge'

type WebhookRow = Pick<
  TradingViewWebhook,
  'id' | 'channel_id' | 'name' | 'token' | 'is_active' | 'created_at' | 'alert_config'
>
type DeliveryRow = Pick<TradingViewWebhookDelivery, 'id' | 'webhook_id' | 'status' | 'skip_reason' | 'created_at'>

function webhookUrl(token: string): string {
  const base = String(import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/$/, '')
  return `${base}/functions/v1/tradingview-webhook/${token}`
}

function formatWhen(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function TradingViewSourcePanel({
  brokers,
  replaceBroker,
}: {
  brokers: BrokerAccount[]
  replaceBroker: (broker: BrokerAccount) => void
}) {
  const { user } = useAuth()
  const t = useT()
  const confirm = useConfirm()
  const copy = t.channelsPage
  const [webhooks, setWebhooks] = useState<WebhookRow[]>([])
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([])
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [linking, setLinking] = useState<string | null>(null)
  const [connectMenuId, setConnectMenuId] = useState<string | null>(null)
  const [connectingBrokerId, setConnectingBrokerId] = useState<string | null>(null)
  const [connectingAllId, setConnectingAllId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [configureId, setConfigureId] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!user?.id) return
    const [hooks, recent] = await Promise.all([
      supabase
        .from('tradingview_webhooks')
        .select('id, channel_id, name, token, is_active, created_at, alert_config')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false }),
      supabase
        .from('tradingview_webhook_deliveries')
        .select('id, webhook_id, status, skip_reason, created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(100),
    ])
    if (hooks.error) setError(hooks.error.message)
    else setWebhooks((hooks.data ?? []) as WebhookRow[])
    if (!recent.error) setDeliveries((recent.data ?? []) as DeliveryRow[])
    setLoading(false)
  }, [user?.id])

  useEffect(() => {
    void load()
  }, [load])

  const run = async (action: () => Promise<{ error: string | null }>) => {
    setBusy(true)
    setError(null)
    const result = await action()
    setBusy(false)
    if (result.error) {
      setError(result.error === 'webhook_limit' ? copy.tradingViewLimit : result.error)
      return false
    }
    await load()
    return true
  }

  const openCreate = () => {
    setName('')
    setError(null)
    setCreateOpen(true)
  }

  const createWebhook = async () => {
    if (!user?.id) return
    const label = name.trim()
    if (!label) {
      setError(copy.tradingViewNameRequired)
      return
    }
    setBusy(true)
    setError(null)
    const result = await createTradingViewWebhook(supabase, user.id, label)
    setBusy(false)
    if (result.error || !result.id) {
      setError(result.error === 'webhook_limit' ? copy.tradingViewLimit : result.error ?? copy.tradingViewNameRequired)
      return
    }
    setName('')
    setCreateOpen(false)
    await load()
    setConfigureId(result.id)
  }

  const copyText = async (key: string, value: string) => {
    await navigator.clipboard.writeText(value)
    setCopied(key)
    window.setTimeout(() => setCopied(current => (current === key ? null : current)), 1500)
  }

  const statusLabel = (status: DeliveryRow['status']) => {
    if (status === 'accepted') return copy.tradingViewAccepted
    if (status === 'skipped') return copy.tradingViewSkipped
    if (status === 'duplicate') return copy.tradingViewDuplicate
    return copy.tradingViewError
  }

  const skipReasonLabel = (reason: string | null | undefined) => {
    if (!reason) return null
    if (reason === 'unresolved_symbol_placeholder') return copy.tradingViewSkipUnresolvedSymbol
    if (reason === 'unresolved_action_placeholder') return copy.tradingViewSkipUnresolvedAction
    return reason
  }

  const selected = webhooks.find(webhook => webhook.id === selectedId) ?? null
  const configuring = webhooks.find(webhook => webhook.id === configureId) ?? null

  const saveAlertConfig = async (webhookId: string, config: TradingViewAlertConfig) => {
    if (!user?.id) return false
    setBusy(true)
    setError(null)
    const result = await updateTradingViewAlertConfig(supabase, user.id, webhookId, config)
    setBusy(false)
    if (result.error) {
      setError(result.error)
      return false
    }
    setWebhooks(current =>
      current.map(webhook => (
        webhook.id === webhookId ? { ...webhook, alert_config: result.config } : webhook
      )),
    )
    return true
  }

  const connectBroker = async (webhook: WebhookRow, brokerId: string) => {
    if (!user?.id) return
    const broker = brokers.find(item => item.id === brokerId)
    if (!broker) return
    setConnectingBrokerId(brokerId)
    setError(null)
    const result = await connectChannelToBroker(supabase, user.id, broker, webhook.channel_id)
    setConnectingBrokerId(null)
    if (result.error || !result.broker) {
      setError(result.error)
      return
    }
    replaceBroker(result.broker)
    setConnectMenuId(null)
  }

  const connectAllBrokers = async (webhook: WebhookRow) => {
    if (!user?.id) return
    setConnectingAllId(webhook.id)
    setError(null)
    const result = await linkChannelToAllActiveBrokers(supabase, user.id, webhook.channel_id, brokers)
    setConnectingAllId(null)
    if (result.error) {
      setError(result.error)
      return
    }
    for (const broker of result.brokers) replaceBroker(broker)
    setConnectMenuId(null)
  }

  const disconnectBroker = async (webhook: WebhookRow, broker: BrokerAccount) => {
    if (!user?.id) return
    setLinking(`${webhook.id}:${broker.id}`)
    const result = await disconnectChannelFromBroker(supabase, user.id, broker, webhook.channel_id)
    setLinking(null)
    if (result.error || !result.broker) {
      setError(result.error)
      return
    }
    replaceBroker(result.broker)
  }

  const lastEventLabel = (webhookId: string) => {
    const last = deliveries.find(row => row.webhook_id === webhookId)
    if (!last) return copy.tradingViewNoDeliveries
    return `${statusLabel(last.status)} · ${formatWhen(last.created_at)}`
  }

  if (loading) return null

  return (
    <>
      {webhooks.length === 0 ? (
        <WelcomeCard copy={copy} error={createOpen ? null : error} onConnect={openCreate} />
      ) : (
        <Card padding="none">
          <div className="flex items-center justify-between gap-3 border-b border-neutral-100 px-4 py-2.5 dark:border-neutral-800">
            <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{copy.tradingViewListTitle}</p>
            <div className="flex items-center gap-3">
              <Button size="sm" onClick={openCreate} aria-label={copy.tradingViewCreate}>
                <Plus className="h-3.5 w-3.5" />
                {t.common.add}
              </Button>
              <span className="text-xs text-neutral-900 dark:text-neutral-50">
                {interpolate(t.copierEnginePage.configuredCount, { count: String(webhooks.length) })}
              </span>
            </div>
          </div>
          {!createOpen && !selected && error ? (
            <p className="border-b border-neutral-100 px-4 py-3 text-sm text-red-600 dark:border-neutral-800 dark:text-red-400">{error}</p>
          ) : null}
          <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {webhooks.map(webhook => (
              <WebhookListRow
                key={webhook.id}
                webhook={webhook}
                brokers={brokers}
                createdLabel={`${copy.tradingViewCreated} · ${formatWhen(webhook.created_at)}`}
                lastEventLabel={`${copy.tradingViewLastEvent} · ${lastEventLabel(webhook.id)}`}
                connectMenuOpen={connectMenuId === webhook.id}
                connectingBrokerId={connectingBrokerId}
                connectingAll={connectingAllId === webhook.id}
                disconnectingLinkKey={linking}
                busy={busy}
                onOpen={() => {
                  setError(null)
                  setSelectedId(webhook.id)
                }}
                onConfigure={() => {
                  setError(null)
                  setConfigureId(webhook.id)
                }}
                onToggleConnectMenu={() => setConnectMenuId(current => (current === webhook.id ? null : webhook.id))}
                onCloseConnectMenu={() => setConnectMenuId(null)}
                onConnectBroker={brokerId => void connectBroker(webhook, brokerId)}
                onConnectAllBrokers={() => void connectAllBrokers(webhook)}
                onDisconnectBroker={broker => void disconnectBroker(webhook, broker)}
                onToggle={checked => {
                  if (!user?.id) return
                  void run(() => setTradingViewWebhookActive(supabase, user.id, webhook.id, checked))
                }}
                onDelete={() => {
                  if (!user?.id) return
                  void confirm({
                    title: copy.tradingViewDelete,
                    body: copy.tradingViewDeleteConfirm
                      ?? 'Delete this TradingView webhook? Its alert URL will stop working.',
                    confirmLabel: copy.tradingViewDelete,
                    cancelLabel: t.common.cancel,
                  }).then(approved => {
                    if (!approved) return
                    void run(async () => {
                      const result = await deleteTradingViewWebhook(supabase, user.id, webhook, brokers)
                      for (const broker of result.brokers) replaceBroker(broker)
                      if (!result.error) {
                        setSelectedId(current => (current === webhook.id ? null : current))
                        setConfigureId(current => (current === webhook.id ? null : current))
                      }
                      return { error: result.error }
                    })
                  })
                }}
              />
            ))}
          </div>
        </Card>
      )}

      {createOpen ? (
        <ModalFrame title={copy.tradingViewCreate} onClose={() => { if (!busy) setCreateOpen(false) }}>
          <form
            className="space-y-4"
            onSubmit={event => {
              event.preventDefault()
              void createWebhook()
            }}
          >
            <Input
              label={copy.tradingViewName}
              value={name}
              autoFocus
              onChange={event => setName(event.target.value)}
              placeholder="TradingView"
            />
            {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
            <Button type="submit" className="w-full" loading={busy}>
              {copy.tradingViewCreate}
            </Button>
          </form>
        </ModalFrame>
      ) : null}

      {selected ? (
        <ModalFrame title={selected.name} onClose={() => { if (!busy) setSelectedId(null) }}>
          <WebhookDetails
            webhook={selected}
            copy={copy}
            error={error}
            copied={copied}
            recent={deliveries.filter(row => row.webhook_id === selected.id).slice(0, 8)}
            statusLabel={statusLabel}
            skipReasonLabel={skipReasonLabel}
            onCopy={copyText}
            onConfigure={() => {
              setSelectedId(null)
              setConfigureId(selected.id)
            }}
            onRotate={() => {
              if (!user?.id) return
              void confirm({
                title: copy.tradingViewRotate,
                body: copy.tradingViewRotateConfirm
                  ?? 'Rotate this alert URL? The old URL will stop accepting alerts immediately.',
                confirmLabel: copy.tradingViewRotate,
                cancelLabel: t.common.cancel,
                tone: 'primary',
              }).then(approved => {
                if (!approved) return
                void run(() => rotateTradingViewWebhook(supabase, user.id, selected.id))
              })
            }}
          />
        </ModalFrame>
      ) : null}

      {configuring ? (
        <ModalFrame
          title={copy.tradingViewConfigureTitle ?? 'Configure alert JSON'}
          onClose={() => { if (!busy) setConfigureId(null) }}
        >
          <WebhookConfigure
            webhook={configuring}
            copy={copy}
            error={error}
            copied={copied}
            busy={busy}
            onCopy={copyText}
            onSave={async config => {
              const ok = await saveAlertConfig(configuring.id, config)
              if (ok) setConfigureId(null)
            }}
          />
        </ModalFrame>
      ) : null}
    </>
  )
}

function WebhookListRow({
  webhook,
  brokers,
  createdLabel,
  lastEventLabel,
  connectMenuOpen,
  connectingBrokerId,
  connectingAll,
  disconnectingLinkKey,
  busy,
  onOpen,
  onConfigure,
  onToggleConnectMenu,
  onCloseConnectMenu,
  onConnectBroker,
  onConnectAllBrokers,
  onDisconnectBroker,
  onToggle,
  onDelete,
}: {
  webhook: WebhookRow
  brokers: BrokerAccount[]
  createdLabel: string
  lastEventLabel: string
  connectMenuOpen: boolean
  connectingBrokerId: string | null
  connectingAll: boolean
  disconnectingLinkKey: string | null
  busy: boolean
  onOpen: () => void
  onConfigure: () => void
  onToggleConnectMenu: () => void
  onCloseConnectMenu: () => void
  onConnectBroker: (brokerId: string) => void
  onConnectAllBrokers: () => void
  onDisconnectBroker: (broker: BrokerAccount) => void
  onToggle: (checked: boolean) => void
  onDelete: () => void
}) {
  const t = useT()
  const ce = t.copierEnginePage
  const menuRef = useRef<HTMLDivElement>(null)
  const connectedBrokers = useMemo(
    () => brokersMatchingChannel(brokers, webhook.channel_id),
    [brokers, webhook.channel_id],
  )
  const availableBrokers = useMemo(
    () => brokersNotMatchingChannel(brokers, webhook.channel_id),
    [brokers, webhook.channel_id],
  )
  const hasAnyBrokers = brokers.some(broker => isBrokerCopyEnabledForUi(broker))

  useEffect(() => {
    if (!connectMenuOpen) return
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) onCloseConnectMenu()
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [connectMenuOpen, onCloseConnectMenu])

  return (
    <div className={clsx('transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-800/80', connectMenuOpen && 'relative z-20')}>
      <div className="flex items-center gap-3 px-4 py-3">
        <img src="/tradingview-logo.png" alt="" className="h-10 w-10 shrink-0 rounded-full object-cover" />
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
          <h3 className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-50">{webhook.name}</h3>
          <p className="mt-0.5 text-xs text-neutral-900 dark:text-neutral-50">{createdLabel}</p>
          <p className="mt-0.5 truncate text-xs text-neutral-900 dark:text-neutral-50">{lastEventLabel}</p>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onConfigure}>
            {t.channelsPage.tradingViewConfigure ?? 'Configure'}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onOpen}>
            {t.channelsPage.tradingViewShowDetails}
          </Button>
          <Toggle checked={webhook.is_active} disabled={busy} onChange={onToggle} />
          <button
            type="button"
            onClick={onDelete}
            className="rounded-lg p-1.5 text-neutral-900 dark:text-neutral-50 transition-colors hover:bg-error-50 hover:text-error-600"
            aria-label={t.channelsPage.tradingViewDelete}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="space-y-2.5 border-t border-neutral-100 bg-neutral-50 px-4 py-2.5 dark:border-neutral-800 dark:bg-neutral-800/60">
        <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-neutral-900 dark:text-neutral-50">{ce.connectedBrokers}</p>
        {connectedBrokers.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {connectedBrokers.map(broker => {
              const label = getBrokerDisplayLabel(broker)
              const linkKey = `${webhook.id}:${broker.id}`
              return (
                <Badge key={broker.id} variant="neutral" size="sm">
                  <span>{label}</span>
                  <button
                    type="button"
                    onClick={() => onDisconnectBroker(broker)}
                    disabled={disconnectingLinkKey === linkKey}
                    className="ml-0.5 -mr-0.5 rounded-full p-0.5 text-neutral-900 dark:text-neutral-50 transition-colors hover:bg-neutral-200 hover:text-neutral-900 disabled:opacity-50 dark:hover:bg-neutral-700 dark:hover:text-neutral-100"
                    aria-label={interpolate(ce.removeBrokerConnectionAria, { broker: label, channel: webhook.name })}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              )
            })}
            <div className="relative" ref={menuRef}>
              <button
                type="button"
                onClick={onToggleConnectMenu}
                className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-neutral-200 text-neutral-900 dark:text-neutral-50 transition-colors hover:bg-white hover:text-neutral-900 dark:border-neutral-700 dark:hover:bg-neutral-900 dark:hover:text-neutral-100"
                aria-label={interpolate(ce.addBrokerConnectionAria, { channel: webhook.name })}
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
              {connectMenuOpen ? (
                <BrokerMenu
                  brokers={availableBrokers}
                  hasAnyBrokers={hasAnyBrokers}
                  emptyLabel={availableBrokers.length === 0 ? ce.connectedBrokers : ce.noBrokersYet}
                  connectingBrokerId={connectingBrokerId}
                  onConnectBroker={onConnectBroker}
                  onClose={onCloseConnectMenu}
                />
              ) : null}
            </div>
          </div>
        ) : hasAnyBrokers ? (
          <div className="flex flex-wrap items-center gap-2">
            {availableBrokers.length >= 2 ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                loading={connectingAll}
                disabled={connectingBrokerId !== null}
                onClick={onConnectAllBrokers}
              >
                {ce.connectAllBrokers}
              </Button>
            ) : null}
            <div className="relative inline-block" ref={menuRef}>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={onToggleConnectMenu}
                loading={connectingBrokerId !== null && !connectingAll}
                disabled={connectingAll}
              >
                {ce.connectToBroker}
              </Button>
              {connectMenuOpen && availableBrokers.length > 0 ? (
                <div className="absolute left-0 top-full z-30 mt-1 min-w-48 rounded-lg border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
                  {availableBrokers.map(broker => (
                    <button
                      key={broker.id}
                      type="button"
                      disabled={connectingBrokerId === broker.id}
                      onClick={() => onConnectBroker(broker.id)}
                      className="w-full px-3 py-2 text-left text-sm text-neutral-900 hover:bg-neutral-50 disabled:opacity-50 dark:text-neutral-100 dark:hover:bg-neutral-800"
                    >
                      {getBrokerDisplayLabel(broker)}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <Link
            to="/brokers"
            className="inline-flex items-center rounded-lg border border-dashed border-neutral-300 px-3 py-1.5 text-xs font-medium text-green-400 transition-colors hover:bg-white dark:border-neutral-600 dark:hover:bg-neutral-900"
          >
            {ce.connectToBroker}
          </Link>
        )}
      </div>
    </div>
  )
}

function BrokerMenu({
  brokers,
  hasAnyBrokers,
  emptyLabel,
  connectingBrokerId,
  onConnectBroker,
  onClose,
}: {
  brokers: BrokerAccount[]
  hasAnyBrokers: boolean
  emptyLabel: string
  connectingBrokerId: string | null
  onConnectBroker: (brokerId: string) => void
  onClose: () => void
}) {
  const ce = useT().copierEnginePage
  return (
    <div className="absolute left-0 top-full z-30 mt-1 min-w-48 rounded-lg border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
      {!hasAnyBrokers || brokers.length === 0 ? (
        <p className="px-3 py-2 text-xs text-neutral-900 dark:text-neutral-50">{emptyLabel}</p>
      ) : (
        brokers.map(broker => (
          <button
            key={broker.id}
            type="button"
            disabled={connectingBrokerId === broker.id}
            onClick={() => onConnectBroker(broker.id)}
            className="w-full px-3 py-2 text-left text-sm text-neutral-900 hover:bg-neutral-50 disabled:opacity-50 dark:text-neutral-100 dark:hover:bg-neutral-800"
          >
            {getBrokerDisplayLabel(broker)}
          </button>
        ))
      )}
      <div className="mt-1 border-t border-neutral-100 pt-1 dark:border-neutral-800">
        <Link to="/brokers" className="block px-3 py-2 text-xs text-green-400 hover:bg-neutral-50 dark:hover:bg-neutral-800" onClick={onClose}>
          {ce.connectBrokerInConfig}
        </Link>
      </div>
    </div>
  )
}

function WelcomeCard({
  copy,
  error,
  onConnect,
}: {
  copy: ReturnType<typeof useT>['channelsPage']
  error: string | null
  onConnect: () => void
}) {
  const steps = [copy.tradingViewHow1, copy.tradingViewHow2, copy.tradingViewHow3]
  return (
    <Card className="overflow-hidden" padding="none">
      <div className="relative border-b border-neutral-100 bg-linear-to-br from-neutral-200/80 via-neutral-50 to-white px-5 pb-5 pt-6 dark:border-neutral-800 dark:from-[#2a2e39] dark:via-[#1e222d] dark:to-neutral-950 sm:px-6 sm:pt-7">
        <div className="mx-auto flex max-w-md flex-col items-center text-center">
          <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl border border-neutral-100 bg-white shadow-md dark:border-neutral-700 dark:bg-neutral-800">
            <img src="/tradingview-logo.png" alt="" className="h-10 w-10 rounded-full object-cover" loading="lazy" aria-hidden />
          </div>
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">{copy.tradingViewHeroTitle}</h2>
          <p className="mt-1 text-sm text-neutral-900 dark:text-neutral-50">{copy.tradingViewHeroSubtitle}</p>
        </div>
      </div>
      <div className="mx-auto max-w-md px-5 py-5 sm:px-6 sm:py-6">
        <ul className="mb-5 space-y-2.5">
          {steps.map((line, index) => (
            <li key={line} className="flex items-start gap-2.5 text-sm text-neutral-900 dark:text-neutral-50">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary-100 text-xs font-semibold text-green-500 dark:bg-primary-900/50 dark:text-primary-300">
                {index + 1}
              </span>
              {line}
            </li>
          ))}
        </ul>
        {error ? <p className="mb-4 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
        <Button size="lg" className="w-full" onClick={onConnect}>
          <img src="/tradingview-logo.png" alt="" className="h-5 w-5 rounded-full object-cover" loading="lazy" aria-hidden />
          {copy.tradingViewConnect}
        </Button>
      </div>
    </Card>
  )
}

function WebhookDetails({
  webhook,
  copy,
  error,
  copied,
  recent,
  statusLabel,
  skipReasonLabel,
  onCopy,
  onConfigure,
  onRotate,
}: {
  webhook: WebhookRow
  copy: ReturnType<typeof useT>['channelsPage']
  error: string | null
  copied: string | null
  recent: DeliveryRow[]
  statusLabel: (status: DeliveryRow['status']) => string
  skipReasonLabel: (reason: string | null | undefined) => string | null
  onCopy: (key: string, value: string) => void
  onConfigure: () => void
  onRotate: () => void
}) {
  const [howToOpen, setHowToOpen] = useState(false)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setHowToOpen(true)}
          className="text-sm font-medium text-green-500 underline-offset-2 hover:underline"
        >
          {copy.tradingViewHowToTitle}
        </button>
        <Button variant="secondary" size="sm" onClick={onRotate}>
          <RefreshCw className="h-3.5 w-3.5" />
          {copy.tradingViewRotate}
        </Button>
      </div>
      {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      <CopyRow
        label={copy.tradingViewUrl}
        value={webhookUrl(webhook.token)}
        copyLabel={copied === webhook.id ? copy.tradingViewCopied : copy.tradingViewCopy}
        onCopy={() => onCopy(webhook.id, webhookUrl(webhook.token))}
      />
      <div className="rounded-xl border border-neutral-200/80 bg-neutral-50/80 px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900/40">
        <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50">
          {copy.tradingViewTemplate}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-neutral-600 dark:text-neutral-400">
          {copy.tradingViewConfigureHint
            ?? 'Build a tailored alert JSON for Indicator or Strategy alerts, including optional SL and TPs.'}
        </p>
        <Button type="button" size="sm" className="mt-3" onClick={onConfigure}>
          {copy.tradingViewConfigureCta ?? 'Configure alert JSON'}
        </Button>
      </div>
      <div>
        <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50">{copy.tradingViewDeliveries}</p>
        {recent.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-900 dark:text-neutral-50">{copy.tradingViewNoDeliveries}</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {recent.map(row => (
              <li key={row.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-neutral-900 dark:text-neutral-50">{formatWhen(row.created_at)}</span>
                <span className="flex items-center gap-2">
                  <Badge variant={row.status === 'accepted' ? 'success' : row.status === 'error' ? 'error' : 'neutral'}>
                    {statusLabel(row.status)}
                  </Badge>
                  {row.skip_reason ? (
                    <span className="max-w-[14rem] text-xs text-neutral-900 dark:text-neutral-50">
                      {skipReasonLabel(row.skip_reason)}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {howToOpen ? (
        <ModalFrame title={copy.tradingViewHowToTitle} nested onClose={() => setHowToOpen(false)}>
          <ol className="list-decimal space-y-2 pl-4 text-sm text-neutral-900 dark:text-neutral-50">
            <li>{copy.tradingViewHowTo1}</li>
            <li>{copy.tradingViewHowTo2}</li>
            <li>{copy.tradingViewHowTo3}</li>
            <li>{copy.tradingViewHowTo4}</li>
          </ol>
        </ModalFrame>
      ) : null}
    </div>
  )
}

function WebhookConfigure({
  webhook,
  copy,
  error,
  copied,
  busy,
  onCopy,
  onSave,
}: {
  webhook: WebhookRow
  copy: ReturnType<typeof useT>['channelsPage']
  error: string | null
  copied: string | null
  busy: boolean
  onCopy: (key: string, value: string) => void
  onSave: (config: TradingViewAlertConfig) => Promise<void>
}) {
  const [config, setConfig] = useState<TradingViewAlertConfig>(() =>
    normalizeTradingViewAlertConfig(webhook.alert_config),
  )
  const templates = useMemo(() => buildTradingViewAlertTemplates(config), [config])
  const selectClass =
    'w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-transparent focus:outline-hidden focus:ring-2 focus:ring-green-400 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100'

  const renderTemplate = (key: string, label: string, body: string, hint?: string) => {
    const copyKey = `${webhook.id}:cfg-${key}`
    return (
      <div key={key}>
        <div className="mb-1.5 flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50">{label}</p>
          <Button variant="secondary" size="sm" onClick={() => onCopy(copyKey, body)}>
            <Copy className="h-3.5 w-3.5" />
            {copied === copyKey ? copy.tradingViewCopied : copy.tradingViewCopy}
          </Button>
        </div>
        <pre className="overflow-x-auto rounded-lg bg-neutral-50 p-3 text-xs text-neutral-900 dark:bg-neutral-900 dark:text-neutral-50">
          {body}
        </pre>
        {hint ? <p className="mt-1.5 text-xs text-neutral-600 dark:text-neutral-400">{hint}</p> : null}
      </div>
    )
  }

  return (
    <form
      className="space-y-4"
      onSubmit={event => {
        event.preventDefault()
        void onSave(normalizeTradingViewAlertConfig(config))
      }}
    >
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-neutral-900 dark:text-neutral-50">
          {copy.tradingViewAlertType ?? 'Alert type'}
        </label>
        <select
          className={selectClass}
          value={config.kind}
          onChange={event => {
            const kind = event.target.value === 'strategy' ? 'strategy' : 'indicator'
            setConfig(current => ({ ...current, kind }))
          }}
        >
          <option value="indicator">{copy.tradingViewAlertTypeIndicator ?? 'Indicator'}</option>
          <option value="strategy">{copy.tradingViewAlertTypeStrategy ?? 'Strategy'}</option>
        </select>
      </div>

      {config.kind === 'indicator' ? (
        <Input
          label={copy.tradingViewSymbol ?? 'Symbol'}
          value={config.symbol ?? 'XAUUSD'}
          onChange={event => setConfig(current => ({ ...current, symbol: event.target.value.toUpperCase() }))}
          hint={copy.tradingViewSymbolHint ?? copy.tradingViewTemplateSymbolHint}
          hintInTooltip
        />
      ) : null}

      <div className="flex items-center justify-between gap-3 rounded-xl border border-neutral-200/80 px-3 py-2.5 dark:border-neutral-800">
        <div>
          <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50">
            {copy.tradingViewIncludeSl ?? 'Include stop loss (SL)'}
          </p>
          <p className="text-xs text-neutral-600 dark:text-neutral-400">
            {copy.tradingViewIncludeSlHint ?? 'Adds an "sl" field. Replace 0 with your Pine value.'}
          </p>
        </div>
        <Toggle
          checked={config.includeSl}
          onChange={checked => setConfig(current => ({ ...current, includeSl: checked }))}
        />
      </div>

      <div className="space-y-3 rounded-xl border border-neutral-200/80 px-3 py-2.5 dark:border-neutral-800">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50">
              {copy.tradingViewIncludeTp ?? 'Include take profits (TP)'}
            </p>
            <p className="text-xs text-neutral-600 dark:text-neutral-400">
              {copy.tradingViewIncludeTpHint ?? 'Adds a "tp" array. Replace each 0 with your Pine values.'}
            </p>
          </div>
          <Toggle
            checked={config.includeTp}
            onChange={checked => setConfig(current => ({ ...current, includeTp: checked }))}
          />
        </div>
        {config.includeTp ? (
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-neutral-900 dark:text-neutral-50">
              {copy.tradingViewTpCount ?? 'Number of TPs'}
            </label>
            <select
              className={selectClass}
              value={String(config.tpCount)}
              onChange={event => {
                const tpCount = Number(event.target.value)
                setConfig(current => ({ ...current, tpCount }))
              }}
            >
              {Array.from(
                { length: TRADINGVIEW_TP_COUNT_MAX - TRADINGVIEW_TP_COUNT_MIN + 1 },
                (_, index) => TRADINGVIEW_TP_COUNT_MIN + index,
              ).map(count => (
                <option key={count} value={count}>{count}</option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      <div className="space-y-3">
        <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50">
          {copy.tradingViewJsonPreview ?? 'Alert JSON'}
        </p>
        <p className="text-xs text-neutral-600 dark:text-neutral-400">
          {copy.tradingViewJsonPlaceholderHint
            ?? 'Paste into the TradingView alert Message field. Replace 0 placeholders with your indicator/strategy values, or omit SL/TP and use broker Override SL/TP instead.'}
        </p>
        {config.kind === 'strategy' && templates.strategy
          ? renderTemplate('strategy', copy.tradingViewTemplateStrategy, templates.strategy)
          : null}
        {config.kind === 'indicator' && templates.buy
          ? renderTemplate(
            'buy',
            copy.tradingViewTemplateBuy,
            templates.buy,
            copy.tradingViewTemplateSymbolHint,
          )
          : null}
        {config.kind === 'indicator' && templates.sell
          ? renderTemplate(
            'sell',
            copy.tradingViewTemplateSell,
            templates.sell,
            copy.tradingViewTemplateSymbolHint,
          )
          : null}
      </div>

      {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      <Button type="submit" className="w-full" loading={busy}>
        {copy.tradingViewSaveConfig ?? 'Save configuration'}
      </Button>
    </form>
  )
}

function ModalFrame({
  title,
  onClose,
  children,
  nested = false,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  nested?: boolean
}) {
  const closeLabel = useT().accountConfig.configureModal.close

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (nested) event.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, nested)
    return () => window.removeEventListener('keydown', onKey, nested)
  }, [nested, onClose])

  return createPortal(
    <div
      className={clsx(
        'fixed inset-0 flex items-end justify-center p-0 sm:items-center sm:p-6',
        nested ? 'z-[60]' : 'z-50',
      )}
      role="dialog"
      aria-modal="true"
    >
      <button type="button" className="absolute inset-0 bg-neutral-950/55" aria-label={closeLabel} onClick={onClose} />
      <div className="relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl border border-neutral-200/65 bg-white shadow-2xl dark:border-neutral-800/55 dark:bg-neutral-950 sm:max-w-lg sm:rounded-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-neutral-100 px-5 py-4 dark:border-neutral-800">
          <h2 className="min-w-0 truncate text-base font-semibold text-neutral-900 dark:text-neutral-50">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-neutral-900 dark:text-neutral-50 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            aria-label={closeLabel}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

function CopyRow({
  label,
  value,
  copyLabel,
  onCopy,
}: {
  label: string
  value: string
  copyLabel: string
  onCopy: () => void
}) {
  return (
    <div>
      <p className="mb-1.5 text-sm font-medium text-neutral-900 dark:text-neutral-50">{label}</p>
      <div className="flex gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg bg-neutral-50 px-3 py-2 text-xs text-neutral-900 dark:bg-neutral-900 dark:text-neutral-50">
          {value}
        </code>
        <Button variant="secondary" size="sm" onClick={onCopy}>
          <Copy className="h-3.5 w-3.5" />
          {copyLabel}
        </Button>
      </div>
    </div>
  )
}

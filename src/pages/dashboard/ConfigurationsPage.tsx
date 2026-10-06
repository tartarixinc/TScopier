import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { Plus, Settings, X } from 'lucide-react'
import { PageHeader } from '../../components/layout/PageHeader'
import { PageShell } from '../../components/layout/PageShell'
import { Badge } from '../../components/ui/Badge'
import { Card } from '../../components/ui/Card'
import { AddConfigurationChannelModal } from '../../components/configure/AddConfigurationChannelModal'
import { useAddTradingAccount } from '../../context/AddTradingAccountContext'
import { useAuth } from '../../context/AuthContext'
import { useBrokerAccounts } from '../../context/BrokerAccountsContext'
import { useSubscription } from '../../context/SubscriptionContext'
import { useT } from '../../context/LocaleContext'
import { interpolate } from '../../i18n/interpolate'
import type { ConfigureModalTranslations } from '../../i18n/locales/configureModal/types'
import type { ConfigurationsPageTranslations } from '../../i18n/locales/types'
import { connectChannelToBroker, disconnectChannelFromBroker, normalizeSignalChannelIds } from '../../lib/brokerChannelLink'
import {
  fetchBrokerChannelTradingConfigRows,
  fetchBrokerChannelTradingConfigRowsForBrokers,
  mergeBrokerWithChannelTradingConfigRows,
  type BrokerChannelTradingConfigRow,
} from '../../lib/brokerChannelTradingConfigs'
import { defaultChannelFiltersForPlan } from '../../lib/channelMessageFilters'
import { describeChannelConfiguration, type ConfigurationDetailSection } from '../../lib/configurationSummary'
import { resolveBrokerTotalBalance } from '../../lib/effectiveBrokerBalance'
import { resolveChannelTradingConfig } from '../../lib/channelTradingConfig'
import { supabase } from '../../lib/supabase'
import type { BrokerAccount } from '../../types/database'

interface ChannelName {
  id: string
  display_name: string
  channel_username: string
  channel_id: string
}

interface Point {
  x: number
  y: number
}

interface Anchor extends Point {
  height: number
}

interface PairSelection {
  brokerId: string
  channelId: string
}

function PlatformLogo({ platform }: { platform: string }) {
  const [failed, setFailed] = useState(false)
  const raw = platform.trim()
  const key = /^mt[45]$/i.test(raw) ? raw.toUpperCase() : raw
  if (!key || failed) return null
  return (
    <img
      src={`/${key}.png`}
      alt=""
      aria-hidden
      className="h-8 w-8 shrink-0 object-contain"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  )
}

function TelegramLogo() {
  return (
    <img
      src="/Telegram.svg"
      alt=""
      aria-hidden
      className="h-7 w-7 shrink-0 object-contain"
    />
  )
}

function channelDisplayName(channel: ChannelName | undefined, fallback: string): string {
  const name = channel?.display_name?.trim()
  if (name) return name
  const username = channel?.channel_username?.trim()
  if (!username) return fallback
  return username.startsWith('@') ? username : `@${username}`
}

function cubicPoint(start: Point, c1: Point, c2: Point, end: Point, t: number): Point {
  const u = 1 - t
  return {
    x: u * u * u * start.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * end.x,
    y: u * u * u * start.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * end.y,
  }
}

function connectorGeometry(start: Point, end: Point, gearT = 0.5): { d: string; gear: Point } {
  const dx = Math.max(48, Math.abs(end.x - start.x) * 0.5)
  const c1 = { x: start.x + dx, y: start.y }
  const c2 = { x: end.x - dx, y: end.y }
  return {
    d: `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`,
    gear: cubicPoint(start, c1, c2, end, gearT),
  }
}

function spreadAnchorY(center: number, height: number, index: number, count: number): number {
  if (count <= 1) return center
  const span = Math.min(Math.max(height - 24, 0), (count - 1) * 28)
  const top = center - span / 2
  return top + (span * index) / (count - 1)
}

export function ConfigurationsPage() {
  const t = useT()
  const copy = t.configurationsPage
  const modalCopy = t.accountConfig.configureModal
  const { openAddTradingAccount } = useAddTradingAccount()
  const { user } = useAuth()
  const { brokers, loading: brokersLoading, replaceBroker } = useBrokerAccounts()
  const { canUseFeature } = useSubscription()
  const [channels, setChannels] = useState<ChannelName[]>([])
  const [channelsLoading, setChannelsLoading] = useState(true)
  const [configRows, setConfigRows] = useState<BrokerChannelTradingConfigRow[]>([])
  const [configsLoading, setConfigsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [openPair, setOpenPair] = useState<PairSelection | null>(null)
  const [addChannelOpen, setAddChannelOpen] = useState(false)
  const [placedChannelIds, setPlacedChannelIds] = useState<string[]>([])
  const [linkError, setLinkError] = useState<string | null>(null)
  const linkingRef = useRef(false)
  const latestBrokersRef = useRef<BrokerAccount[]>([])
  const linkChainRef = useRef(Promise.resolve())

  const brokerIdsKey = brokers.map(broker => broker.id).join(',')

  useEffect(() => {
    if (!user?.id) {
      setChannels([])
      setChannelsLoading(false)
      return
    }
    let cancelled = false
    setChannelsLoading(true)
    void supabase
      .from('telegram_channels')
      .select('id,display_name,channel_username,channel_id')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) setLoadError(error.message)
        setChannels((data ?? []) as ChannelName[])
        setChannelsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [user?.id])

  useEffect(() => {
    const ids = brokerIdsKey ? brokerIdsKey.split(',') : []
    if (!user?.id || ids.length === 0) {
      setConfigRows([])
      setConfigsLoading(false)
      return
    }
    let cancelled = false
    setConfigsLoading(true)
    void fetchBrokerChannelTradingConfigRowsForBrokers(supabase, ids).then(({ rows, error }) => {
      if (cancelled) return
      if (error) setLoadError(error)
      setConfigRows(rows)
      setConfigsLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [user?.id, brokerIdsKey])

  const channelById = useMemo(() => {
    const map = new Map<string, ChannelName>()
    for (const channel of channels) map.set(channel.id.toLowerCase(), channel)
    return map
  }, [channels])

  const mergedBrokers = useMemo(() => {
    const rowsByBroker = new Map<string, BrokerChannelTradingConfigRow[]>()
    for (const row of configRows) {
      const list = rowsByBroker.get(row.broker_account_id) ?? []
      list.push(row)
      rowsByBroker.set(row.broker_account_id, list)
    }
    return brokers.map(broker =>
      mergeBrokerWithChannelTradingConfigRows(broker, rowsByBroker.get(broker.id) ?? []),
    )
  }, [brokers, configRows])

  const linkedChannelIds = useMemo(() => {
    const ids: string[] = []
    const seen = new Set<string>()
    for (const broker of mergedBrokers) {
      for (const id of normalizeSignalChannelIds(broker.signal_channel_ids)) {
        if (seen.has(id)) continue
        seen.add(id)
        ids.push(id)
      }
    }
    const knownOrder = channels
      .map(channel => channel.id.toLowerCase())
      .filter(id => seen.has(id))
    const unknown = ids.filter(id => !knownOrder.includes(id))
    return [...knownOrder, ...unknown]
  }, [mergedBrokers, channels])

  const mapChannelIds = useMemo(() => {
    const linked = new Set(linkedChannelIds)
    const placed = new Set(placedChannelIds)
    const known = channels
      .map(channel => channel.id.toLowerCase())
      .filter(id => linked.has(id) || placed.has(id))
    const knownSet = new Set(known)
    return [...known, ...linkedChannelIds.filter(id => !knownSet.has(id))]
  }, [channels, linkedChannelIds, placedChannelIds])

  const availableChannels = useMemo(() => {
    const shown = new Set(mapChannelIds)
    return channels.filter(channel => !shown.has(channel.id.toLowerCase()))
  }, [channels, mapChannelIds])

  const placeChannel = (channelId: string) => {
    const id = channelId.toLowerCase()
    setPlacedChannelIds(prev => (prev.includes(id) ? prev : [...prev, id]))
    setAddChannelOpen(false)
  }

  useEffect(() => {
    if (linkingRef.current) return
    latestBrokersRef.current = mergedBrokers
  }, [mergedBrokers])

  const connectDraggedChannel = (channelId: string, brokerId: string) => {
    const task = linkChainRef.current.then(async () => {
      if (!user?.id) return
      const broker = latestBrokersRef.current.find(item => item.id === brokerId)
      if (!broker) return
      if (normalizeSignalChannelIds(broker.signal_channel_ids).includes(channelId.toLowerCase())) return
      linkingRef.current = true
      setLinkError(null)
      const { broker: updated, error } = await connectChannelToBroker(
        supabase,
        user.id,
        broker,
        channelId,
        { defaultChannelFilters: defaultChannelFiltersForPlan(canUseFeature('channel_keyword_filters')) },
      )
      if (error || !updated) {
        linkingRef.current = false
        setLinkError(error ?? copy.loadError)
        return
      }
      latestBrokersRef.current = latestBrokersRef.current.map(item =>
        item.id === updated.id ? { ...item, ...updated } : item,
      )
      replaceBroker(updated)
      const { rows, error: configError } = await fetchBrokerChannelTradingConfigRows(supabase, updated.id)
      linkingRef.current = false
      if (configError) {
        setLinkError(configError)
        return
      }
      setConfigRows(prev => [...prev.filter(row => row.broker_account_id !== updated.id), ...rows])
    })
    linkChainRef.current = task.then(() => undefined, () => undefined)
    return task
  }

  const disconnectDraggedChannel = (channelId: string, brokerId: string) => {
    const task = linkChainRef.current.then(async () => {
      if (!user?.id) return
      const broker = latestBrokersRef.current.find(item => item.id === brokerId)
      if (!broker) return
      if (!normalizeSignalChannelIds(broker.signal_channel_ids).includes(channelId.toLowerCase())) return
      linkingRef.current = true
      setLinkError(null)
      const { broker: updated, error } = await disconnectChannelFromBroker(supabase, user.id, broker, channelId)
      if (error || !updated) {
        linkingRef.current = false
        setLinkError(error ?? copy.loadError)
        return
      }
      latestBrokersRef.current = latestBrokersRef.current.map(item =>
        item.id === updated.id ? { ...item, ...updated } : item,
      )
      replaceBroker(updated)
      const { rows, error: configError } = await fetchBrokerChannelTradingConfigRows(supabase, updated.id)
      linkingRef.current = false
      if (configError) {
        setLinkError(configError)
        return
      }
      setConfigRows(prev => [...prev.filter(row => row.broker_account_id !== updated.id), ...rows])
    })
    linkChainRef.current = task.then(() => undefined, () => undefined)
    return task
  }

  const loading = brokersLoading || channelsLoading || configsLoading
  const selectedBroker = openPair
    ? mergedBrokers.find(broker => broker.id === openPair.brokerId) ?? null
    : null

  return (
    <PageShell>
      <PageHeader title={copy.title} />

      {loadError ? (
        <p className="text-sm text-error-600 dark:text-error-400">{copy.loadError}</p>
      ) : null}
      {linkError ? (
        <p className="text-sm text-error-600 dark:text-error-400">{linkError}</p>
      ) : null}

      {loading ? (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_160px_minmax(0,1fr)]" aria-hidden>
          <Card padding="sm"><div className="h-12 animate-pulse rounded bg-neutral-100 dark:bg-white/5" /></Card>
          <div className="hidden lg:block" />
          <Card padding="sm"><div className="h-12 animate-pulse rounded bg-neutral-100 dark:bg-white/5" /></Card>
        </div>
      ) : (
        <>
          {mergedBrokers.length === 0 ? (
            <Card className="text-center">
              <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-50">{copy.emptyTitle}</h2>
              <p className="mx-auto mt-2 max-w-md text-sm text-neutral-500 dark:text-neutral-400">{copy.emptyBody}</p>
            </Card>
          ) : null}
          <ConfigurationMap
            brokers={mergedBrokers}
            linkedChannelIds={mapChannelIds}
            channelById={channelById}
            copy={copy}
            onOpen={setOpenPair}
            onAddChannel={() => setAddChannelOpen(true)}
            onAddBroker={openAddTradingAccount}
            onConnect={(channelId, brokerId) => connectDraggedChannel(channelId, brokerId)}
            onDisconnect={(channelId, brokerId) => disconnectDraggedChannel(channelId, brokerId)}
          />
          <ConfigurationStack
            brokers={mergedBrokers}
            linkedChannelIds={mapChannelIds}
            channelById={channelById}
            copy={copy}
            onOpen={setOpenPair}
            onAddChannel={() => setAddChannelOpen(true)}
            onAddBroker={openAddTradingAccount}
          />
        </>
      )}

      {addChannelOpen ? (
        <AddConfigurationChannelModal
          channels={availableChannels}
          catalog={channels}
          emptyLabel={channels.length === 0 ? t.channelsPage.emptySubtitle : copy.noAvailableChannels}
          onClose={() => setAddChannelOpen(false)}
          onSelect={placeChannel}
          onCreated={channel => {
            setChannels(prev => [{
              id: channel.id,
              display_name: channel.display_name,
              channel_username: channel.channel_username,
              channel_id: channel.channel_id ?? '',
            }, ...prev.filter(row => row.id !== channel.id)])
            placeChannel(channel.id)
          }}
        />
      ) : null}

      {selectedBroker && openPair ? (
        <ConfigurationModal
          broker={selectedBroker}
          channelId={openPair.channelId}
          channelName={channelDisplayName(channelById.get(openPair.channelId), copy.unknownChannel)}
          copy={copy}
          modalCopy={modalCopy}
          closeLabel={modalCopy.close}
          onClose={() => setOpenPair(null)}
        />
      ) : null}
    </PageShell>
  )
}

function ConfigurationMap({
  brokers,
  linkedChannelIds,
  channelById,
  copy,
  onOpen,
  onAddChannel,
  onAddBroker,
  onConnect,
  onDisconnect,
}: {
  brokers: BrokerAccount[]
  linkedChannelIds: string[]
  channelById: Map<string, ChannelName>
  copy: ConfigurationsPageTranslations
  onOpen: (pair: PairSelection) => void
  onAddChannel: () => void
  onAddBroker: () => void
  onConnect: (channelId: string, brokerId: string) => Promise<void>
  onDisconnect: (channelId: string, brokerId: string) => Promise<void>
}) {
  const mapRef = useRef<HTMLDivElement>(null)
  const channelRefs = useRef(new Map<string, HTMLElement>())
  const brokerRefs = useRef(new Map<string, HTMLElement>())
  const [anchors, setAnchors] = useState<{
    channels: Record<string, Anchor>
    brokers: Record<string, Anchor>
  }>({ channels: {}, brokers: {} })
  const dragRef = useRef<
    | { kind: 'connect'; channelId: string }
    | { kind: 'disconnect'; channelId: string; brokerId: string; start: Point }
    | null
  >(null)
  const [drag, setDrag] = useState<
    | { kind: 'connect'; channelId: string; pointer: Point; overBrokerId: string | null }
    | { kind: 'disconnect'; channelId: string; brokerId: string; pointer: Point; start: Point; overBroker: boolean }
    | null
  >(null)
  const [pendingLink, setPendingLink] = useState<{ channelId: string; brokerId: string } | null>(null)
  const [pendingUnlink, setPendingUnlink] = useState<{ channelId: string; brokerId: string } | null>(null)

  const connections = useMemo(() => {
    const linked = brokers.flatMap(broker =>
      normalizeSignalChannelIds(broker.signal_channel_ids).map(channelId => ({
        brokerId: broker.id,
        channelId,
      })),
    )
    if (!pendingLink) return linked
    const exists = linked.some(item =>
      item.brokerId === pendingLink.brokerId && item.channelId === pendingLink.channelId,
    )
    return exists ? linked : [...linked, pendingLink]
  }, [brokers, pendingLink])

  const brokerUnderPointer = (clientX: number, clientY: number): string | null => {
    let found: string | null = null
    let best = Number.POSITIVE_INFINITY
    brokerRefs.current.forEach((el, id) => {
      const rect = el.getBoundingClientRect()
      const inside = clientX >= rect.left - 20
        && clientX <= rect.right
        && clientY >= rect.top
        && clientY <= rect.bottom
      if (!inside) return
      const distance = Math.abs(clientY - (rect.top + rect.height / 2))
      if (distance < best) {
        best = distance
        found = id
      }
    })
    return found
  }

  const pointerInMap = (clientX: number, clientY: number): Point | null => {
    const map = mapRef.current
    if (!map) return null
    const box = map.getBoundingClientRect()
    return { x: clientX - box.left, y: clientY - box.top }
  }

  const beginPointerDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return false
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    return true
  }

  const onPortPointerDown = (channelId: string, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!beginPointerDrag(event)) return
    dragRef.current = { kind: 'connect', channelId }
    const pointer = pointerInMap(event.clientX, event.clientY)
    if (!pointer) return
    setDrag({
      kind: 'connect',
      channelId,
      pointer,
      overBrokerId: brokerUnderPointer(event.clientX, event.clientY),
    })
  }

  const onEndPointerDown = (
    channelId: string,
    brokerId: string,
    start: Point,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (!beginPointerDrag(event)) return
    dragRef.current = { kind: 'disconnect', channelId, brokerId, start }
    const pointer = pointerInMap(event.clientX, event.clientY)
    if (!pointer) return
    setDrag({
      kind: 'disconnect',
      channelId,
      brokerId,
      start,
      pointer,
      overBroker: brokerUnderPointer(event.clientX, event.clientY) === brokerId,
    })
  }

  const onPortPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = dragRef.current
    if (!current) return
    const pointer = pointerInMap(event.clientX, event.clientY)
    if (!pointer) return
    if (current.kind === 'connect') {
      setDrag({
        kind: 'connect',
        channelId: current.channelId,
        pointer,
        overBrokerId: brokerUnderPointer(event.clientX, event.clientY),
      })
      return
    }
    setDrag({
      kind: 'disconnect',
      channelId: current.channelId,
      brokerId: current.brokerId,
      start: current.start,
      pointer,
      overBroker: brokerUnderPointer(event.clientX, event.clientY) === current.brokerId,
    })
  }

  const onPortPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = dragRef.current
    dragRef.current = null
    setDrag(null)
    if (!current) return
    if (current.kind === 'disconnect') {
      const stillOnBroker = brokerUnderPointer(event.clientX, event.clientY) === current.brokerId
      if (stillOnBroker) return
      setPendingUnlink({ channelId: current.channelId, brokerId: current.brokerId })
      void onDisconnect(current.channelId, current.brokerId).finally(() => setPendingUnlink(null))
      return
    }
    const brokerId = brokerUnderPointer(event.clientX, event.clientY)
    if (!brokerId) return
    const alreadyLinked = brokers.some(broker =>
      broker.id === brokerId
      && normalizeSignalChannelIds(broker.signal_channel_ids).includes(current.channelId),
    )
    if (alreadyLinked) return
    setPendingLink({ channelId: current.channelId, brokerId })
    void onConnect(current.channelId, brokerId).finally(() => setPendingLink(null))
  }

  const onPortPointerCancel = () => {
    dragRef.current = null
    setDrag(null)
  }

  const layoutKey = `${linkedChannelIds.join(',')}|${brokers.map(broker => broker.id).join(',')}|${connections.map(item => `${item.channelId}:${item.brokerId}`).join(',')}`

  useLayoutEffect(() => {
    const map = mapRef.current
    if (!map) return
    const measure = () => {
      const box = map.getBoundingClientRect()
      if (box.width === 0) return
      const nextChannels: Record<string, Anchor> = {}
      const nextBrokers: Record<string, Anchor> = {}
      channelRefs.current.forEach((el, id) => {
        const rect = el.getBoundingClientRect()
        nextChannels[id] = {
          x: rect.right - box.left,
          y: rect.top + rect.height / 2 - box.top,
          height: rect.height,
        }
      })
      brokerRefs.current.forEach((el, id) => {
        const rect = el.getBoundingClientRect()
        nextBrokers[id] = {
          x: rect.left - box.left,
          y: rect.top + rect.height / 2 - box.top,
          height: rect.height,
        }
      })
      setAnchors({ channels: nextChannels, brokers: nextBrokers })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(map)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [layoutKey])

  const dragPreview = drag
    ? (() => {
        if (drag.kind === 'disconnect') return connectorGeometry(drag.start, drag.pointer)
        const start = anchors.channels[drag.channelId]
        if (!start) return null
        return connectorGeometry(start, drag.pointer)
      })()
    : null

  const curves = (() => {
    const ready = connections.flatMap(connection => {
      if (pendingUnlink?.channelId === connection.channelId && pendingUnlink.brokerId === connection.brokerId) return []
      const startAnchor = anchors.channels[connection.channelId]
      const endAnchor = anchors.brokers[connection.brokerId]
      if (!startAnchor || !endAnchor) return []
      return [{ ...connection, startAnchor, endAnchor }]
    })
    const channelsByBroker = new Map<string, string[]>()
    const brokersByChannel = new Map<string, string[]>()
    for (const connection of ready) {
      const channelIds = channelsByBroker.get(connection.brokerId) ?? []
      channelIds.push(connection.channelId)
      channelsByBroker.set(connection.brokerId, channelIds)
      const brokerIds = brokersByChannel.get(connection.channelId) ?? []
      brokerIds.push(connection.brokerId)
      brokersByChannel.set(connection.channelId, brokerIds)
    }
    const yOfChannel = (id: string) => anchors.channels[id]?.y ?? 0
    const yOfBroker = (id: string) => anchors.brokers[id]?.y ?? 0
    channelsByBroker.forEach((ids, brokerId) => {
      channelsByBroker.set(brokerId, [...ids].sort((a, b) => yOfChannel(a) - yOfChannel(b) || a.localeCompare(b)))
    })
    brokersByChannel.forEach((ids, channelId) => {
      brokersByChannel.set(channelId, [...ids].sort((a, b) => yOfBroker(a) - yOfBroker(b) || a.localeCompare(b)))
    })
    const placedGears: Point[] = []
    return ready.map(connection => {
      const channelMates = brokersByChannel.get(connection.channelId) ?? [connection.brokerId]
      const brokerMates = channelsByBroker.get(connection.brokerId) ?? [connection.channelId]
      const start = {
        x: connection.startAnchor.x,
        y: spreadAnchorY(
          connection.startAnchor.y,
          connection.startAnchor.height,
          Math.max(0, channelMates.indexOf(connection.brokerId)),
          channelMates.length,
        ),
      }
      const end = {
        x: connection.endAnchor.x,
        y: spreadAnchorY(
          connection.endAnchor.y,
          connection.endAnchor.height,
          Math.max(0, brokerMates.indexOf(connection.channelId)),
          brokerMates.length,
        ),
      }
      const gearSlots = [0.5, 0.36, 0.64, 0.24, 0.76]
      let geometry = connectorGeometry(start, end, 0.5)
      for (const slot of gearSlots) {
        geometry = connectorGeometry(start, end, slot)
        const overlaps = placedGears.some(gear =>
          Math.hypot(gear.x - geometry.gear.x, gear.y - geometry.gear.y) < 40,
        )
        if (!overlaps) break
      }
      placedGears.push(geometry.gear)
      return { ...connection, ...geometry, start, end }
    })
  })()

  return (
    <div
      ref={mapRef}
      dir="ltr"
      className="relative hidden lg:grid lg:grid-cols-[minmax(220px,1fr)_168px_minmax(220px,1fr)] lg:items-start"
    >
      <div className="space-y-3">
        {linkedChannelIds.map(channelId => (
          <div
            key={channelId}
            ref={el => {
              if (el) channelRefs.current.set(channelId, el)
              else channelRefs.current.delete(channelId)
            }}
            className="relative"
          >
            <ChannelNode name={channelDisplayName(channelById.get(channelId), copy.unknownChannel)} />
            <button
              type="button"
              className="absolute end-0 top-1/2 z-30 h-3.5 w-3.5 -translate-y-1/2 translate-x-1/2 cursor-grab touch-none rounded-full bg-teal-500 ring-2 ring-white hover:scale-110 active:cursor-grabbing dark:ring-neutral-950"
              aria-label={interpolate(copy.dragToConnect, {
                channel: channelDisplayName(channelById.get(channelId), copy.unknownChannel),
              })}
              onPointerDown={event => onPortPointerDown(channelId, event)}
              onPointerMove={onPortPointerMove}
              onPointerUp={onPortPointerUp}
              onPointerCancel={onPortPointerCancel}
            />
          </div>
        ))}
        <AddSectionAction label={copy.addChannel} onClick={onAddChannel} />
      </div>
      <div />
      <div className="space-y-3">
        {brokers.map(broker => (
          <div
            key={broker.id}
            ref={el => {
              if (el) brokerRefs.current.set(broker.id, el)
              else brokerRefs.current.delete(broker.id)
            }}
            className={`relative rounded-2xl ${
              (drag?.kind === 'connect' && drag.overBrokerId === broker.id)
              || (drag?.kind === 'disconnect' && drag.brokerId === broker.id && drag.overBroker)
                ? 'ring-2 ring-teal-500'
                : ''
            }`}
          >
            {normalizeSignalChannelIds(broker.signal_channel_ids).length === 0 ? (
              <span className="absolute start-0 top-1/2 z-30 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-teal-500 ring-2 ring-white dark:ring-neutral-950" />
            ) : null}
            <BrokerNode broker={broker} copy={copy} />
          </div>
        ))}
        <AddSectionAction label={copy.addBroker} onClick={onAddBroker} />
      </div>

      <svg className="pointer-events-none absolute inset-0 z-10 h-full w-full overflow-visible" aria-hidden>
        {curves.filter(curve => !(
          drag?.kind === 'disconnect'
          && drag.channelId === curve.channelId
          && drag.brokerId === curve.brokerId
        )).map(curve => (
          <path
            key={`${curve.channelId}:${curve.brokerId}`}
            d={curve.d}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-teal-500"
          />
        ))}
        {dragPreview ? (
          <path
            d={dragPreview.d}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeDasharray="6 4"
            className={drag?.kind === 'disconnect' && !drag.overBroker ? 'text-error-500' : 'text-teal-400'}
          />
        ) : null}
      </svg>

      {curves.filter(curve => !(
        drag?.kind === 'disconnect'
        && drag.channelId === curve.channelId
        && drag.brokerId === curve.brokerId
      )).map(curve => {
        const broker = brokers.find(item => item.id === curve.brokerId)
        const channelName = channelDisplayName(channelById.get(curve.channelId), copy.unknownChannel)
        return (
          <button
            key={`${curve.channelId}:${curve.brokerId}`}
            type="button"
            className="absolute z-40 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-teal-200 bg-white text-teal-700 shadow-sm hover:bg-teal-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 dark:border-teal-800 dark:bg-neutral-950 dark:text-teal-300 dark:hover:bg-teal-950"
            style={{ left: curve.gear.x, top: curve.gear.y }}
            aria-label={interpolate(copy.viewConfiguration, {
              channel: channelName,
              broker: broker?.label ?? '',
            })}
            onClick={() => onOpen({ brokerId: curve.brokerId, channelId: curve.channelId })}
          >
            <Settings className="h-4 w-4" />
          </button>
        )
      })}

      {curves.map(curve => {
        const broker = brokers.find(item => item.id === curve.brokerId)
        const channelName = channelDisplayName(channelById.get(curve.channelId), copy.unknownChannel)
        return (
          <button
            key={`end:${curve.channelId}:${curve.brokerId}`}
            type="button"
            className="absolute z-40 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none rounded-full bg-teal-500 ring-2 ring-white hover:scale-110 active:cursor-grabbing dark:ring-neutral-950"
            style={{
              left: drag?.kind === 'disconnect' && drag.channelId === curve.channelId && drag.brokerId === curve.brokerId
                ? drag.pointer.x
                : curve.end.x,
              top: drag?.kind === 'disconnect' && drag.channelId === curve.channelId && drag.brokerId === curve.brokerId
                ? drag.pointer.y
                : curve.end.y,
            }}
            aria-label={interpolate(copy.dragToDisconnect, {
              channel: channelName,
              broker: broker?.label ?? '',
            })}
            onPointerDown={event => onEndPointerDown(curve.channelId, curve.brokerId, curve.start, event)}
            onPointerMove={onPortPointerMove}
            onPointerUp={onPortPointerUp}
            onPointerCancel={onPortPointerCancel}
          />
        )
      })}
    </div>
  )
}

function ConfigurationStack({
  brokers,
  linkedChannelIds,
  channelById,
  copy,
  onOpen,
  onAddChannel,
  onAddBroker,
}: {
  brokers: BrokerAccount[]
  linkedChannelIds: string[]
  channelById: Map<string, ChannelName>
  copy: ConfigurationsPageTranslations
  onOpen: (pair: PairSelection) => void
  onAddChannel: () => void
  onAddBroker: () => void
}) {
  const unlinked = brokers.filter(broker => normalizeSignalChannelIds(broker.signal_channel_ids).length === 0)

  return (
    <div className="space-y-6 lg:hidden">
      {linkedChannelIds.map(channelId => {
        const name = channelDisplayName(channelById.get(channelId), copy.unknownChannel)
        const linkedBrokers = brokers.filter(broker =>
          normalizeSignalChannelIds(broker.signal_channel_ids).includes(channelId),
        )
        return (
          <div key={channelId} className="space-y-0">
            <ChannelNode name={name} />
            {linkedBrokers.map(broker => (
              <div key={broker.id} className="flex flex-col items-center">
                <div className="h-4 w-0.5 bg-teal-500" />
                <button
                  type="button"
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-teal-200 bg-white text-teal-700 shadow-sm dark:border-teal-800 dark:bg-neutral-950 dark:text-teal-300"
                  aria-label={interpolate(copy.viewConfiguration, { channel: name, broker: broker.label })}
                  onClick={() => onOpen({ brokerId: broker.id, channelId })}
                >
                  <Settings className="h-4 w-4" />
                </button>
                <div className="h-4 w-0.5 bg-teal-500" />
                <div className="w-full">
                  <BrokerNode broker={broker} copy={copy} />
                </div>
              </div>
            ))}
          </div>
        )
      })}
      <AddSectionAction label={copy.addChannel} onClick={onAddChannel} />
      {unlinked.map(broker => (
        <BrokerNode key={broker.id} broker={broker} copy={copy} />
      ))}
      <AddSectionAction label={copy.addBroker} onClick={onAddBroker} />
    </div>
  )
}

function AddSectionAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-neutral-300 bg-white px-4 py-3 text-sm font-medium text-teal-700 hover:border-teal-400 hover:bg-teal-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-teal-300 dark:hover:border-teal-700 dark:hover:bg-teal-950/40"
    >
      <Plus className="h-4 w-4" />
      {label}
    </button>
  )
}

function ChannelNode({ name }: { name: string }) {
  return (
    <Card padding="sm">
      <p className="flex items-center gap-2.5 text-sm font-semibold text-neutral-900 dark:text-neutral-50">
        <TelegramLogo />
        <span dir="auto" className="min-w-0 truncate">{name}</span>
      </p>
    </Card>
  )
}

function BrokerNode({
  broker,
  copy,
}: {
  broker: BrokerAccount
  copy: ConfigurationsPageTranslations
}) {
  const login = broker.account_login?.trim()
  const linked = normalizeSignalChannelIds(broker.signal_channel_ids).length > 0
  return (
    <Card padding="sm">
      <div className="flex min-w-0 items-center gap-3">
        <PlatformLogo platform={broker.platform} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{broker.label}</h2>
            <Badge variant="neutral" size="sm">{broker.platform}</Badge>
            <Badge variant={broker.is_active ? 'success' : 'neutral'} size="sm">
              {broker.is_active ? copy.copyingOn : copy.copyingOff}
            </Badge>
          </div>
          {login ? (
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              {copy.login} {login}
            </p>
          ) : null}
          {linked ? null : (
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{copy.noChannelsLinked}</p>
          )}
        </div>
      </div>
    </Card>
  )
}

function ConfigurationModal({
  broker,
  channelId,
  channelName,
  copy,
  modalCopy,
  closeLabel,
  onClose,
}: {
  broker: BrokerAccount
  channelId: string
  channelName: string
  copy: ConfigurationsPageTranslations
  modalCopy: ConfigureModalTranslations
  closeLabel: string
  onClose: () => void
}) {
  const resolved = resolveChannelTradingConfig(broker, channelId)
  const sections = describeChannelConfiguration(
    resolved.manual_settings,
    modalCopy,
    copy,
    { accountBalance: resolveBrokerTotalBalance(broker) },
  )

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="configuration-pair-title"
    >
      <button
        type="button"
        className="absolute inset-0 bg-neutral-950/55"
        aria-label={closeLabel}
        onClick={onClose}
      />
      <div className="relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl border border-neutral-200/65 bg-white shadow-2xl dark:border-neutral-800/55 dark:bg-neutral-950 sm:max-w-2xl sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-neutral-100 px-5 py-4 dark:border-neutral-800">
          <div className="min-w-0">
            <h2 id="configuration-pair-title" className="flex items-center gap-2 text-base font-semibold text-neutral-900 dark:text-neutral-50">
              <TelegramLogo />
              <span className="truncate">{channelName}</span>
            </h2>
            <p className="mt-2 flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300">
              <PlatformLogo platform={broker.platform} />
              <span className="truncate">{broker.label}</span>
            </p>
          </div>
          <button
            type="button"
            className="rounded-lg p-2 text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
            aria-label={closeLabel}
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">
          <ConfigurationSections sections={sections} />
        </div>
        <div className="flex justify-end gap-2 border-t border-neutral-100 px-5 py-4 dark:border-neutral-800">
          <button
            type="button"
            className="rounded-lg px-4 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
            onClick={onClose}
          >
            {closeLabel}
          </button>
          <Link
            to={`/brokers?configure=${encodeURIComponent(broker.id)}&channel=${encodeURIComponent(channelId)}`}
            className="inline-flex items-center justify-center rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700"
          >
            {copy.edit}
          </Link>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function ConfigurationSections({ sections }: { sections: ConfigurationDetailSection[] }) {
  return (
    <div className="space-y-4">
      {sections.map(section => (
        <section key={section.id}>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
            {section.title}
          </h3>
          <dl className="mt-1">
            {section.rows.map(row => (
              <div
                key={`${section.id}-${row.label}`}
                className="flex items-baseline justify-between gap-4 border-b border-neutral-100 py-1.5 last:border-b-0 dark:border-neutral-800"
              >
                <dt className="text-sm text-neutral-500 dark:text-neutral-400">{row.label}</dt>
                <dd className="text-end text-sm font-medium text-neutral-900 dark:text-neutral-50">{row.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  )
}

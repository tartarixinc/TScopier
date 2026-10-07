import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { Plus, Settings, Trash2, X } from 'lucide-react'
import { PageHeader } from '../../components/layout/PageHeader'
import { PageShell } from '../../components/layout/PageShell'
import { Badge } from '../../components/ui/Badge'
import { Card } from '../../components/ui/Card'
import { AddConfigurationChannelModal } from '../../components/configure/AddConfigurationChannelModal'
import { AddConfigurationDestinationModal } from '../../components/configure/AddConfigurationDestinationModal'
import { ConfigurationSettingsEditor } from '../../components/configure/ConfigurationSettingsEditor'
import { useAddTradingAccount } from '../../context/AddTradingAccountContext'
import { useAuth } from '../../context/AuthContext'
import { useBrokerAccounts } from '../../context/BrokerAccountsContext'
import { useSubscription } from '../../context/SubscriptionContext'
import { useT } from '../../context/LocaleContext'
import { interpolate } from '../../i18n/interpolate'
import type { ConfigureModalTranslations } from '../../i18n/locales/configureModal/types'
import type { ConfigurationsPageTranslations } from '../../i18n/locales/types'
import { connectChannelToBroker, disconnectChannelFromBroker, getBrokerDisplayLabel, normalizeSignalChannelIds } from '../../lib/brokerChannelLink'
import {
  connectBrokerCopyLink,
  disconnectBrokerCopyLink,
  fetchBrokerCopyLinks,
  setBrokerCopySource,
  updateBrokerCopyLinkSettings,
  type BrokerCopyLinkRow,
} from '../../lib/brokerCopyLink'
import { DEFAULT_MANUAL_SETTINGS } from '../../lib/defaultManualSettings'
import {
  fetchBrokerChannelTradingConfigRows,
  fetchBrokerChannelTradingConfigRowsForBrokers,
  mergeBrokerWithChannelTradingConfigRows,
  upsertBrokerChannelTradingConfigs,
  type BrokerChannelTradingConfigRow,
} from '../../lib/brokerChannelTradingConfigs'
import { defaultChannelFiltersForPlan } from '../../lib/channelMessageFilters'
import { resolveChannelTradingConfig } from '../../lib/channelTradingConfig'
import { formatMoneyWithCode } from '../../lib/currency'
import { resolveBrokerTotalBalance } from '../../lib/effectiveBrokerBalance'
import {
  formatLinkedAccountTypeLabel,
  resolveLinkedAccountTypeForBroker,
  type LinkedAccountTypeLabels,
} from '../../lib/brokerFromServer'
import { supabase } from '../../lib/supabase'
import type { BrokerAccount, Json, ManualSettings } from '../../types/database'

interface ChannelName {
  id: string
  display_name: string
  channel_username: string
  channel_id: string
  subscriber_count: number | null
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

interface CardDrag {
  kind: 'channel' | 'broker' | 'source'
  id: string
  overBin: boolean
  x: number
  y: number
  offsetX: number
  offsetY: number
  width: number
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

function mergeOrder(order: string[], ids: string[]): string[] {
  const present = new Set(ids)
  const kept = order.filter(id => present.has(id))
  const extra = ids.filter(id => !kept.includes(id))
  return [...kept, ...extra]
}

const CHANNEL_ORDER_KEY = 'tscopier:configurations:channel-order:'
const PLACED_CHANNEL_KEY = 'tscopier:configurations:placed-channels:'
const BROKER_ORDER_KEY = 'tscopier:configurations:broker-order:'
const DESTINATION_KEY = 'tscopier:configurations:placed-destinations:'
const DISMISSED_DESTINATION_KEY = 'tscopier:configurations:dismissed-destinations:'

function readStoredOrder(key: string): string[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0)
  } catch {
    return []
  }
}

function writeStoredOrder(key: string, ids: string[]) {
  try {
    if (ids.length === 0) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(ids))
  } catch {
    // A full quota or private mode should not block reshuffling.
  }
}

function sameOrder(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

function reorderList(ids: string[], fromId: string, toId: string, placeAfter: boolean): string[] {
  if (fromId === toId) return ids
  const next = ids.filter(id => id !== fromId)
  let index = next.indexOf(toId)
  if (index < 0) return ids
  if (placeAfter) index += 1
  next.splice(index, 0, fromId)
  return next
}

function channelDisplayName(channel: ChannelName | undefined, fallback: string): string {
  const name = channel?.display_name?.trim()
  if (name) return name
  const username = channel?.channel_username?.trim()
  if (!username) return fallback
  return username.startsWith('@') ? username : `@${username}`
}

function curveThrough(start: Point, end: Point, gear: Point): { d: string; gear: Point } {
  const towardGear = (start.x + gear.x) / 2
  const towardEnd = (gear.x + end.x) / 2
  return {
    d: `M ${start.x} ${start.y} C ${towardGear} ${start.y}, ${towardGear} ${gear.y}, ${gear.x} ${gear.y} C ${towardEnd} ${gear.y}, ${towardEnd} ${end.y}, ${end.x} ${end.y}`,
    gear,
  }
}

function connectorGeometry(start: Point, end: Point): { d: string; gear: Point } {
  return curveThrough(start, end, {
    x: (start.x + end.x) / 2,
    y: (start.y + end.y) / 2,
  })
}

function spreadAnchorY(center: number, height: number, index: number, count: number): number {
  if (count <= 1) return center
  const span = Math.min(Math.max(height - 20, 0), (count - 1) * 22)
  const top = center - span / 2
  return top + (span * index) / (count - 1)
}

const GEAR_CLEARANCE = 46

function nearestGearDistance(point: Point, placed: Point[]): number {
  let nearest = Number.POSITIVE_INFINITY
  for (const other of placed) {
    nearest = Math.min(nearest, Math.hypot(point.x - other.x, point.y - other.y))
  }
  return nearest
}

function placeConnectionGears(routes: { start: Point; end: Point }[]): Point[] {
  const gears: Point[] = new Array(routes.length)
  const placed: Point[] = []
  const order = routes
    .map((route, index) => ({ index, y: (route.start.y + route.end.y) / 2 }))
    .sort((a, b) => a.y - b.y || a.index - b.index)

  for (const item of order) {
    const route = routes[item.index]
    const spanX = route.end.x - route.start.x
    const spanY = route.end.y - route.start.y
    let best = { x: route.start.x + spanX * 0.5, y: route.start.y + spanY * 0.5 }
    let bestDistance = nearestGearDistance(best, placed)
    if (bestDistance < GEAR_CLEARANCE) {
      for (let step = 1; step <= 8; step++) {
        for (const sign of [1, -1] as const) {
          const t = 0.5 + sign * step * 0.04
          if (t < 0.28 || t > 0.72) continue
          const point = { x: route.start.x + spanX * t, y: route.start.y + spanY * t }
          const distance = nearestGearDistance(point, placed)
          if (distance > bestDistance) {
            best = point
            bestDistance = distance
          }
        }
        if (bestDistance >= GEAR_CLEARANCE) break
      }
    }
    gears[item.index] = best
    placed.push(best)
  }
  return gears
}

export function ConfigurationsPage() {
  const t = useT()
  const copy = t.configurationsPage
  const modalCopy = t.accountConfig.configureModal
  const {
    openAddTradingAccount,
    pendingSourceBroker,
    clearPendingSourceBroker,
    pendingDestinationBrokers,
    clearPendingDestinationBrokers,
  } = useAddTradingAccount()
  const { user } = useAuth()
  const { brokers, loading: brokersLoading, replaceBroker } = useBrokerAccounts()
  const { canUseFeature } = useSubscription()
  const [channels, setChannels] = useState<ChannelName[]>([])
  const [channelsLoading, setChannelsLoading] = useState(true)
  const [configRows, setConfigRows] = useState<BrokerChannelTradingConfigRow[]>([])
  const [copyLinks, setCopyLinks] = useState<BrokerCopyLinkRow[]>([])
  const [configsLoading, setConfigsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [openPair, setOpenPair] = useState<PairSelection | null>(null)
  const [addChannelOpen, setAddChannelOpen] = useState(false)
  const [addDestinationOpen, setAddDestinationOpen] = useState(false)
  const [placedChannelIds, setPlacedChannelIds] = useState<string[]>(() =>
    user?.id ? readStoredOrder(`${PLACED_CHANNEL_KEY}${user.id}`) : [],
  )
  const [placedDestinationIds, setPlacedDestinationIds] = useState<string[]>(() =>
    user?.id ? readStoredOrder(`${DESTINATION_KEY}${user.id}`) : [],
  )
  const [dismissedDestinationIds, setDismissedDestinationIds] = useState<string[]>(() =>
    user?.id ? readStoredOrder(`${DISMISSED_DESTINATION_KEY}${user.id}`) : [],
  )
  const [removedDestinationIds, setRemovedDestinationIds] = useState<string[]>([])
  const [linkError, setLinkError] = useState<string | null>(null)
  const [configSaveError, setConfigSaveError] = useState<string | null>(null)
  const [channelOrder, setChannelOrder] = useState<string[]>(() =>
    user?.id ? readStoredOrder(`${CHANNEL_ORDER_KEY}${user.id}`) : [],
  )
  const [brokerOrder, setBrokerOrder] = useState<string[]>(() =>
    user?.id ? readStoredOrder(`${BROKER_ORDER_KEY}${user.id}`) : [],
  )
  const [storedOrderUserId, setStoredOrderUserId] = useState<string | null>(() => user?.id ?? null)
  const [removedChannelIds, setRemovedChannelIds] = useState<string[]>([])
  const linkingRef = useRef(false)
  const latestBrokersRef = useRef<BrokerAccount[]>([])
  const linkChainRef = useRef(Promise.resolve())
  const displayedChannelOrderRef = useRef<string[]>([])
  const configRowsRef = useRef(configRows)
  const copyLinksRef = useRef(copyLinks)
  const settingsSaveRef = useRef(Promise.resolve())
  configRowsRef.current = configRows
  copyLinksRef.current = copyLinks

  const brokerIdsKey = brokers.map(broker => broker.id).join(',')

  useEffect(() => {
    if (!user?.id) return
    setChannelOrder(readStoredOrder(`${CHANNEL_ORDER_KEY}${user.id}`))
    setPlacedChannelIds(readStoredOrder(`${PLACED_CHANNEL_KEY}${user.id}`))
    setBrokerOrder(readStoredOrder(`${BROKER_ORDER_KEY}${user.id}`))
    setPlacedDestinationIds(readStoredOrder(`${DESTINATION_KEY}${user.id}`))
    setDismissedDestinationIds(readStoredOrder(`${DISMISSED_DESTINATION_KEY}${user.id}`))
    setStoredOrderUserId(user.id)
  }, [user?.id])

  useEffect(() => {
    if (!user?.id || storedOrderUserId !== user.id) return
    writeStoredOrder(`${CHANNEL_ORDER_KEY}${user.id}`, channelOrder)
    writeStoredOrder(`${PLACED_CHANNEL_KEY}${user.id}`, placedChannelIds)
    writeStoredOrder(`${BROKER_ORDER_KEY}${user.id}`, brokerOrder)
    writeStoredOrder(`${DESTINATION_KEY}${user.id}`, placedDestinationIds)
    writeStoredOrder(`${DISMISSED_DESTINATION_KEY}${user.id}`, dismissedDestinationIds)
  }, [user?.id, storedOrderUserId, channelOrder, placedChannelIds, brokerOrder, placedDestinationIds, dismissedDestinationIds])

  useEffect(() => {
    if (!user?.id) {
      setChannels([])
      setChannelsLoading(false)
      return
    }
    let cancelled = false
    setChannelsLoading(true)
    void (async () => {
      const { data, error } = await supabase
        .from('telegram_channels')
        .select('id,display_name,channel_username,channel_id,signal_channel_id')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
      if (cancelled) return
      if (error) {
        setLoadError(error.message)
        setChannels([])
        setChannelsLoading(false)
        return
      }
      const rows = (data ?? []) as Array<ChannelName & { signal_channel_id?: string | null }>
      const registryIds = [...new Set(rows.map(row => row.signal_channel_id).filter((id): id is string => Boolean(id)))]
      const counts = new Map<string, number>()
      if (registryIds.length > 0) {
        const countsResult = await supabase
          .from('signal_channels')
          .select('id,subscriber_count')
          .in('id', registryIds)
        if (!cancelled && !countsResult.error) {
          for (const row of countsResult.data ?? []) {
            counts.set(row.id, row.subscriber_count)
          }
        }
      }
      if (cancelled) return
      setChannels(rows.map(row => ({
        id: row.id,
        display_name: row.display_name,
        channel_username: row.channel_username,
        channel_id: row.channel_id,
        subscriber_count: row.signal_channel_id ? counts.get(row.signal_channel_id) ?? null : null,
      })))
      setChannelsLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [user?.id])

  useEffect(() => {
    if (!user?.id) {
      setCopyLinks([])
      return
    }
    let cancelled = false
    void fetchBrokerCopyLinks(supabase, user.id).then(({ links, error }) => {
      if (cancelled) return
      if (error) setLinkError(error)
      setCopyLinks(links)
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
    // Channel rows arrive newest-first. Show older ones above so a channel
    // just added lands at the bottom of the column.
    const oldestFirst = [...known].reverse()
    const extras: string[] = []
    for (const id of [...linkedChannelIds, ...placedChannelIds]) {
      if (knownSet.has(id) || extras.includes(id)) continue
      extras.push(id)
    }
    return [...oldestFirst, ...extras]
  }, [channels, linkedChannelIds, placedChannelIds])

  const availableChannels = useMemo(() => {
    const shown = new Set(mapChannelIds)
    return channels.filter(channel => !shown.has(channel.id.toLowerCase()))
  }, [channels, mapChannelIds])

  const retainChannel = (channelId: string) => {
    const id = channelId.toLowerCase()
    setPlacedChannelIds(prev => (prev.includes(id) ? prev : [...prev, id]))
    setChannelOrder(prev => {
      const displayed = displayedChannelOrderRef.current
      if (displayed.includes(id)) return sameOrder(prev, displayed) ? prev : displayed
      return prev.includes(id) ? prev : [...prev, id]
    })
  }

  const disconnectLeft = (leftId: string, brokerId: string) => {
    if (sourceBrokerIds.includes(leftId)) return disconnectDraggedSource(leftId, brokerId)
    retainChannel(leftId)
    return disconnectDraggedChannel(leftId, brokerId)
  }

  const placeChannel = (channelId: string) => {
    const id = channelId.toLowerCase()
    setPlacedChannelIds(prev => (prev.includes(id) ? prev : [...prev, id]))
    setChannelOrder(prev => {
      const base = (prev.length > 0 ? prev : displayedChannelOrderRef.current).filter(item => item !== id)
      return [...base, id]
    })
    setAddChannelOpen(false)
  }

  const placeDestination = (brokerId: string) => {
    setDismissedDestinationIds(prev => prev.filter(id => id !== brokerId))
    setPlacedDestinationIds(prev => (prev.includes(brokerId) ? prev : [...prev, brokerId]))
    setBrokerOrder(prev => {
      const base = prev.filter(item => item !== brokerId)
      return [...base, brokerId]
    })
    setAddDestinationOpen(false)
  }

  const appendLeft = (id: string) => {
    setChannelOrder(prev => {
      const base = (prev.length > 0 ? prev : displayedChannelOrderRef.current).filter(item => item !== id)
      return [...base, id]
    })
  }

  const placeSourceBroker = (brokerId: string) => {
    const task = linkChainRef.current.then(async () => {
      if (!user?.id) return
      linkingRef.current = true
      setLinkError(null)
      const { broker, error } = await setBrokerCopySource(supabase, user.id, brokerId, true)
      linkingRef.current = false
      if (error || !broker) {
        setLinkError(error ?? copy.loadError)
        return
      }
      latestBrokersRef.current = latestBrokersRef.current.map(item =>
        item.id === broker.id ? { ...item, ...broker } : item,
      )
      replaceBroker(broker)
      setCopyLinks(prev => prev.filter(link => link.destination_broker_account_id !== brokerId))
      setPlacedDestinationIds(prev => prev.filter(id => id !== brokerId))
      appendLeft(brokerId)
    })
    linkChainRef.current = task.then(() => undefined, () => undefined)
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
      if (!user?.id) return false
      const broker = latestBrokersRef.current.find(item => item.id === brokerId)
      if (!broker) return false
      if (!normalizeSignalChannelIds(broker.signal_channel_ids).includes(channelId.toLowerCase())) return true
      linkingRef.current = true
      setLinkError(null)
      const { broker: updated, error } = await disconnectChannelFromBroker(supabase, user.id, broker, channelId)
      if (error || !updated) {
        linkingRef.current = false
        setLinkError(error ?? copy.loadError)
        return false
      }
      latestBrokersRef.current = latestBrokersRef.current.map(item =>
        item.id === updated.id ? { ...item, ...updated } : item,
      )
      replaceBroker(updated)
      const { rows, error: configError } = await fetchBrokerChannelTradingConfigRows(supabase, updated.id)
      linkingRef.current = false
      if (configError) {
        setLinkError(configError)
        return false
      }
      setConfigRows(prev => [...prev.filter(row => row.broker_account_id !== updated.id), ...rows])
      return true
    })
    linkChainRef.current = task.then(() => undefined, () => undefined)
    return task
  }

  const removeDraggedChannel = async (channelId: string) => {
    if (!user?.id) return
    const id = channelId.toLowerCase()
    const snapshot = {
      placed: placedChannelIds,
      order: channelOrder,
    }
    setRemovedChannelIds(prev => (prev.includes(id) ? prev : [...prev, id]))
    setPlacedChannelIds(prev => prev.filter(channel => channel !== id))
    setChannelOrder(prev => prev.filter(channel => channel !== id))
    setOpenPair(current => (current?.channelId === id ? null : current))

    const restore = () => {
      setRemovedChannelIds(prev => prev.filter(channel => channel !== id))
      setPlacedChannelIds(snapshot.placed)
      setChannelOrder(snapshot.order)
    }

    const linked = latestBrokersRef.current.filter(broker =>
      normalizeSignalChannelIds(broker.signal_channel_ids).includes(id),
    )
    for (const broker of linked) {
      const removed = await disconnectDraggedChannel(id, broker.id)
      if (!removed) {
        restore()
        return
      }
    }
    setRemovedChannelIds(prev => prev.filter(channel => channel !== id))
  }

  const patchChannelSettings = (brokerId: string, channelId: string, patch: Partial<ManualSettings>) => {
    const task = settingsSaveRef.current.then(async () => {
      if (!user?.id) return
      const broker = latestBrokersRef.current.find(item => item.id === brokerId)
      if (!broker) return
      const key = channelId.toLowerCase()
      const resolved = resolveChannelTradingConfig(broker, key)
      const nextSettings = { ...resolved.manual_settings, ...patch }
      const previousBroker = broker
      const previousRows = configRowsRef.current
      const nextBroker: BrokerAccount = {
        ...broker,
        channel_trading_configs: {
          ...(broker.channel_trading_configs && typeof broker.channel_trading_configs === 'object'
            ? broker.channel_trading_configs as Record<string, Json>
            : {}),
          [key]: {
            copier_mode: resolved.copier_mode,
            manual_settings: nextSettings,
            ai_settings: resolved.ai_settings,
          },
        } as Json,
      }
      const nextRows = withChannelSettings(
        previousRows,
        brokerId,
        key,
        nextSettings,
        resolved.copier_mode,
        resolved.ai_settings,
      )
      latestBrokersRef.current = latestBrokersRef.current.map(item => item.id === brokerId ? nextBroker : item)
      configRowsRef.current = nextRows
      replaceBroker(nextBroker)
      setConfigRows(nextRows)
      setConfigSaveError(null)
      const { error } = await upsertBrokerChannelTradingConfigs(supabase, user.id, brokerId, {
        [key]: {
          copier_mode: resolved.copier_mode,
          manual_settings: nextSettings,
          ai_settings: resolved.ai_settings ?? {},
        },
      })
      if (!error) return
      latestBrokersRef.current = latestBrokersRef.current.map(item => item.id === brokerId ? previousBroker : item)
      configRowsRef.current = previousRows
      replaceBroker(previousBroker)
      setConfigRows(previousRows)
      setConfigSaveError(error)
    })
    settingsSaveRef.current = task.then(() => undefined, () => undefined)
  }

  const sourceBrokers = useMemo(
    () => mergedBrokers.filter(broker => broker.copy_source === true),
    [mergedBrokers],
  )
  const sourceBrokerIds = useMemo(() => sourceBrokers.map(broker => broker.id), [sourceBrokers])

  const connectDraggedSource = (sourceId: string, destinationId: string) => {
    const task = linkChainRef.current.then(async () => {
      if (!user?.id || sourceId === destinationId) return
      if (copyLinksRef.current.some(link =>
        link.source_broker_account_id === sourceId && link.destination_broker_account_id === destinationId,
      )) return
      linkingRef.current = true
      setLinkError(null)
      const { link, error } = await connectBrokerCopyLink(supabase, user.id, sourceId, destinationId)
      linkingRef.current = false
      if (error || !link) {
        setLinkError(error ?? copy.loadError)
        return
      }
      setCopyLinks(prev => prev.some(item => item.id === link.id) ? prev : [...prev, link])
    })
    linkChainRef.current = task.then(() => undefined, () => undefined)
    return task
  }

  const disconnectDraggedSource = (sourceId: string, destinationId: string) => {
    const task = linkChainRef.current.then(async () => {
      if (!user?.id) return false
      const previous = copyLinksRef.current
      setCopyLinks(prev => prev.filter(link =>
        link.source_broker_account_id !== sourceId || link.destination_broker_account_id !== destinationId,
      ))
      linkingRef.current = true
      const { error } = await disconnectBrokerCopyLink(supabase, user.id, sourceId, destinationId)
      linkingRef.current = false
      if (!error) return true
      setCopyLinks(previous)
      setLinkError(error)
      return false
    })
    linkChainRef.current = task.then(() => undefined, () => undefined)
    return task
  }

  const removeSourceBroker = (brokerId: string) => {
    if (!user?.id) return
    const previousBroker = latestBrokersRef.current.find(broker => broker.id === brokerId) ?? null
    const previousLinks = copyLinksRef.current
    const previousOrder = channelOrder
    const previousDestinations = placedDestinationIds
    const previousDismissed = dismissedDestinationIds
    if (previousBroker) replaceBroker({ ...previousBroker, copy_source: false })
    setCopyLinks(prev => prev.filter(link => link.source_broker_account_id !== brokerId))
    setChannelOrder(prev => prev.filter(id => id !== brokerId))
    setPlacedDestinationIds(prev => prev.filter(id => id !== brokerId))
    setDismissedDestinationIds(prev => (prev.includes(brokerId) ? prev : [...prev, brokerId]))
    setOpenPair(current => (current?.channelId === brokerId ? null : current))
    const task = linkChainRef.current.then(async () => {
      const { broker, error } = await setBrokerCopySource(supabase, user.id, brokerId, false)
      if (error || !broker) {
        if (previousBroker) replaceBroker(previousBroker)
        setCopyLinks(previousLinks)
        setChannelOrder(previousOrder)
        setPlacedDestinationIds(previousDestinations)
        setDismissedDestinationIds(previousDismissed)
        setLinkError(error ?? copy.loadError)
        return
      }
      latestBrokersRef.current = latestBrokersRef.current.map(item =>
        item.id === broker.id ? { ...item, ...broker } : item,
      )
      replaceBroker(broker)
      setCopyLinks(prev => prev.filter(link => link.source_broker_account_id !== brokerId))
    })
    linkChainRef.current = task.then(() => undefined, () => undefined)
  }

  const removeDestination = async (brokerId: string) => {
    if (!user?.id) return
    const previousPlaced = placedDestinationIds
    const broker = latestBrokersRef.current.find(item => item.id === brokerId) ?? null
    const channelIds = normalizeSignalChannelIds(broker?.signal_channel_ids)
    const destinationLinks = copyLinksRef.current.filter(link => link.destination_broker_account_id === brokerId)
    setRemovedDestinationIds(prev => (prev.includes(brokerId) ? prev : [...prev, brokerId]))
    setPlacedDestinationIds(prev => prev.filter(id => id !== brokerId))
    setOpenPair(current => (current?.brokerId === brokerId ? null : current))

    const restore = () => {
      setRemovedDestinationIds(prev => prev.filter(id => id !== brokerId))
      setPlacedDestinationIds(previousPlaced)
    }

    for (const channelId of channelIds) {
      retainChannel(channelId)
      const removed = await disconnectDraggedChannel(channelId, brokerId)
      if (!removed) {
        restore()
        return
      }
    }
    for (const link of destinationLinks) {
      const removed = await disconnectDraggedSource(link.source_broker_account_id, brokerId)
      if (!removed) {
        restore()
        return
      }
    }
    setRemovedDestinationIds(prev => prev.filter(id => id !== brokerId))
  }

  const patchBrokerLinkSettings = (sourceId: string, destinationId: string, patch: Partial<ManualSettings>) => {
    const task = settingsSaveRef.current.then(async () => {
      if (!user?.id) return
      const current = copyLinksRef.current.find(link =>
        link.source_broker_account_id === sourceId && link.destination_broker_account_id === destinationId,
      )
      if (!current) return
      const nextSettings = { ...current.manual_settings, ...patch }
      const previous = copyLinksRef.current
      const nextLinks = previous.map(link =>
        link.id === current.id ? { ...link, manual_settings: nextSettings } : link,
      )
      copyLinksRef.current = nextLinks
      setCopyLinks(nextLinks)
      setConfigSaveError(null)
      const { error } = await updateBrokerCopyLinkSettings(supabase, user.id, current.id, nextSettings)
      if (!error) return
      copyLinksRef.current = previous
      setCopyLinks(previous)
      setConfigSaveError(error)
    })
    settingsSaveRef.current = task.then(() => undefined, () => undefined)
  }

  useEffect(() => {
    if (!pendingSourceBroker || !user?.id) return
    const brokerId = pendingSourceBroker.id
    clearPendingSourceBroker()
    placeSourceBroker(brokerId)
  }, [pendingSourceBroker, user?.id, clearPendingSourceBroker])

  useEffect(() => {
    if (pendingDestinationBrokers.length === 0 || !user?.id) return
    const ids = pendingDestinationBrokers.map(broker => broker.id)
    clearPendingDestinationBrokers()
    for (const id of ids) placeDestination(id)
  }, [pendingDestinationBrokers, user?.id, clearPendingDestinationBrokers])

  const orderedChannelIds = useMemo(
    () => mergeOrder(channelOrder, [...mapChannelIds, ...sourceBrokerIds]).filter(id => !removedChannelIds.includes(id)),
    [channelOrder, mapChannelIds, sourceBrokerIds, removedChannelIds],
  )
  displayedChannelOrderRef.current = orderedChannelIds
  const orderedBrokers = useMemo(() => {
    const hidden = new Set(removedChannelIds)
    const placed = new Set(placedDestinationIds)
    const linkedDestinationIds = new Set(copyLinks.map(link => link.destination_broker_account_id))
    const dismissed = new Set(dismissedDestinationIds)
    const destinations = mergedBrokers.filter(broker => {
      if (broker.copy_source === true || removedDestinationIds.includes(broker.id) || dismissed.has(broker.id)) return false
      if (placed.has(broker.id)) return true
      if (normalizeSignalChannelIds(broker.signal_channel_ids).length > 0) return true
      return linkedDestinationIds.has(broker.id)
    })
    // Broker accounts arrive newest-first. Reverse so a broker just added
    // is the last card, and keep any dragged order ahead of that.
    const ids = mergeOrder(brokerOrder, [...destinations].reverse().map(broker => broker.id))
    return ids.flatMap(id => {
      const broker = mergedBrokers.find(item => item.id === id)
      if (!broker) return []
      if (hidden.size === 0) return [broker]
      const linked = normalizeSignalChannelIds(broker.signal_channel_ids)
      const next = linked.filter(channelId => !hidden.has(channelId))
      if (next.length === linked.length) return [broker]
      return [{ ...broker, signal_channel_ids: next }]
    })
  }, [brokerOrder, mergedBrokers, removedChannelIds, placedDestinationIds, dismissedDestinationIds, removedDestinationIds, copyLinks])
  const visibleBrokerLinks = useMemo(
    () => copyLinks
      .filter(link => sourceBrokerIds.includes(link.source_broker_account_id))
      .map(link => ({
        sourceId: link.source_broker_account_id,
        destinationId: link.destination_broker_account_id,
      })),
    [copyLinks, sourceBrokerIds],
  )
  const availableSourceBrokers = useMemo(
    () => mergedBrokers
      .filter(broker => broker.copy_source !== true)
      .map(broker => ({
        id: broker.id,
        label: getBrokerDisplayLabel(broker),
        platform: broker.platform || 'MT5',
        login: broker.account_login?.trim() || '',
      })),
    [mergedBrokers],
  )

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
            brokers={orderedBrokers}
            sources={sourceBrokers}
            brokerLinks={visibleBrokerLinks}
            linkedChannelIds={orderedChannelIds}
            channelById={channelById}
            copy={copy}
            onOpen={setOpenPair}
            onAddChannel={() => setAddChannelOpen(true)}
            onAddBroker={() => setAddDestinationOpen(true)}
            onConnect={(leftId, brokerId) => (
              sourceBrokerIds.includes(leftId)
                ? connectDraggedSource(leftId, brokerId)
                : connectDraggedChannel(leftId, brokerId)
            )}
            onDisconnect={disconnectLeft}
            onReorderChannels={setChannelOrder}
            onReorderBrokers={setBrokerOrder}
            onRemoveChannel={channelId => { void removeDraggedChannel(channelId) }}
            onRemoveSource={brokerId => { void removeSourceBroker(brokerId) }}
            onRemoveDestination={brokerId => { void removeDestination(brokerId) }}
          />
          <ConfigurationStack
            brokers={orderedBrokers}
            sources={sourceBrokers}
            brokerLinks={visibleBrokerLinks}
            linkedChannelIds={orderedChannelIds}
            channelById={channelById}
            copy={copy}
            onOpen={setOpenPair}
            onAddChannel={() => setAddChannelOpen(true)}
            onAddBroker={() => setAddDestinationOpen(true)}
            onReorderChannels={setChannelOrder}
            onReorderBrokers={setBrokerOrder}
            onRemoveChannel={channelId => { void removeDraggedChannel(channelId) }}
            onRemoveSource={brokerId => { void removeSourceBroker(brokerId) }}
            onRemoveDestination={brokerId => { void removeDestination(brokerId) }}
          />
        </>
      )}

      {addChannelOpen ? (
        <AddConfigurationChannelModal
          channels={availableChannels}
          brokers={availableSourceBrokers}
          catalog={channels}
          emptyLabel={channels.length === 0 ? t.channelsPage.emptySubtitle : copy.noAvailableChannels}
          brokerEmptyLabel={mergedBrokers.length === 0 ? t.accountConfig.brokersEmptySubtitle : copy.noAvailableBrokers}
          onClose={() => setAddChannelOpen(false)}
          onSelect={placeChannel}
          onSelectBroker={placeSourceBroker}
          onAddBroker={() => {
            setAddChannelOpen(false)
            openAddTradingAccount({ asCopySource: true })
          }}
          onCreated={channel => {
            setChannels(prev => [{
              id: channel.id,
              display_name: channel.display_name,
              channel_username: channel.channel_username,
              channel_id: channel.channel_id ?? '',
              subscriber_count: null,
            }, ...prev.filter(row => row.id !== channel.id)])
            placeChannel(channel.id)
          }}
        />
      ) : null}

      {addDestinationOpen ? (
        <AddConfigurationDestinationModal
          brokers={mergedBrokers
            .filter(broker => broker.copy_source !== true)
            .map(broker => ({
              id: broker.id,
              label: getBrokerDisplayLabel(broker),
              platform: broker.platform || 'MT5',
              login: broker.account_login?.trim() || '',
            }))}
          emptyLabel={mergedBrokers.length === 0 ? t.accountConfig.brokersEmptySubtitle : copy.noAvailableBrokers}
          onClose={() => setAddDestinationOpen(false)}
          onSelect={placeDestination}
          onAddBroker={() => {
            setAddDestinationOpen(false)
            openAddTradingAccount({ asDestination: true })
          }}
        />
      ) : null}

      {selectedBroker && openPair ? (
        <ConfigurationModal
          broker={selectedBroker}
          sourceBroker={sourceBrokers.find(broker => broker.id === openPair.channelId) ?? null}
          channelId={openPair.channelId}
          channelName={channelDisplayName(channelById.get(openPair.channelId), copy.unknownChannel)}
          settings={sourceBrokerIds.includes(openPair.channelId)
            ? (copyLinks.find(link =>
              link.source_broker_account_id === openPair.channelId
              && link.destination_broker_account_id === openPair.brokerId,
            )?.manual_settings ?? { ...DEFAULT_MANUAL_SETTINGS })
            : null}
          copy={copy}
          modalCopy={modalCopy}
          closeLabel={modalCopy.close}
          multiTradeEnabled={canUseFeature('multi_trade_style')}
          saveError={configSaveError}
          onPatch={patch => {
            setConfigSaveError(null)
            if (sourceBrokerIds.includes(openPair.channelId)) {
              patchBrokerLinkSettings(openPair.channelId, selectedBroker.id, patch)
              return
            }
            patchChannelSettings(selectedBroker.id, openPair.channelId, patch)
          }}
          onError={setConfigSaveError}
          onClose={() => {
            setConfigSaveError(null)
            setOpenPair(null)
          }}
        />
      ) : null}
    </PageShell>
  )
}

function draggedCard(
  drag: CardDrag,
  brokers: BrokerAccount[],
  sources: BrokerAccount[],
  channelById: Map<string, ChannelName>,
  copy: ConfigurationsPageTranslations,
) {
  if (drag.kind === 'channel') {
    return (
      <ChannelNode
        channel={channelById.get(drag.id)}
        name={channelDisplayName(channelById.get(drag.id), copy.unknownChannel)}
        copy={copy}
      />
    )
  }
  if (drag.kind === 'source') {
    const source = sources.find(item => item.id === drag.id)
    return source ? <BrokerNode broker={source} copy={copy} linked master /> : null
  }
  const broker = brokers.find(item => item.id === drag.id)
  return broker ? <BrokerNode broker={broker} copy={copy} /> : null
}

function CardDragGhost({ drag, children }: { drag: CardDrag; children: ReactNode }) {
  return createPortal(
    <div
      className="pointer-events-none fixed z-[80]"
      style={{
        left: drag.x - drag.offsetX,
        top: drag.y - drag.offsetY,
        width: drag.width,
        transform: drag.overBin ? 'scale(0.86)' : 'translateY(-6px) scale(1.03)',
        opacity: drag.overBin ? 0.72 : 1,
      }}
    >
      <div className={drag.overBin ? '' : 'shadow-xl'}>{children}</div>
    </div>,
    document.body,
  )
}

function dragSlotClass(dragging: boolean) {
  return `relative touch-none select-none cursor-grab ${dragging ? 'cursor-grabbing opacity-40' : ''}`
}

function useCardPointerSession() {
  const moveRef = useRef<(event: PointerEvent) => void>(() => {})
  const endRef = useRef<(event: PointerEvent) => void>(() => {})
  const stopRef = useRef<(() => void) | null>(null)

  const stop = () => {
    document.body.style.cursor = ''
    stopRef.current?.()
  }

  const begin = () => {
    stop()
    const move = (event: PointerEvent) => moveRef.current(event)
    const end = (event: PointerEvent) => {
      stop()
      endRef.current(event)
    }
    window.addEventListener('pointermove', move, true)
    window.addEventListener('pointerup', end, true)
    window.addEventListener('pointercancel', end, true)
    document.body.style.cursor = 'grabbing'
    stopRef.current = () => {
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('pointerup', end, true)
      window.removeEventListener('pointercancel', end, true)
      stopRef.current = null
    }
  }

  useEffect(() => () => {
    document.body.style.cursor = ''
    stopRef.current?.()
  }, [])

  return { moveRef, endRef, begin, stop }
}

function isLeftDrag(kind: CardDrag['kind']) {
  return kind === 'channel' || kind === 'source'
}

function removeDragLabel(kind: CardDrag['kind'], copy: ConfigurationsPageTranslations) {
  if (kind === 'source') return copy.removeSource
  if (kind === 'broker') return copy.removeDestination
  return copy.removeChannel
}

function ConfigurationMap({
  brokers,
  sources,
  brokerLinks,
  linkedChannelIds,
  channelById,
  copy,
  onOpen,
  onAddChannel,
  onAddBroker,
  onConnect,
  onDisconnect,
  onReorderChannels,
  onReorderBrokers,
  onRemoveChannel,
  onRemoveSource,
  onRemoveDestination,
}: {
  brokers: BrokerAccount[]
  sources: BrokerAccount[]
  brokerLinks: { sourceId: string; destinationId: string }[]
  linkedChannelIds: string[]
  channelById: Map<string, ChannelName>
  copy: ConfigurationsPageTranslations
  onOpen: (pair: PairSelection) => void
  onAddChannel: () => void
  onAddBroker: () => void
  onConnect: (channelId: string, brokerId: string) => Promise<void>
  onDisconnect: (channelId: string, brokerId: string) => Promise<boolean | void>
  onReorderChannels: (ids: string[]) => void
  onReorderBrokers: (ids: string[]) => void
  onRemoveChannel: (channelId: string) => void
  onRemoveSource: (brokerId: string) => void
  onRemoveDestination: (brokerId: string) => void
}) {
  const mapRef = useRef<HTMLDivElement>(null)
  const channelRefs = useRef(new Map<string, HTMLElement>())
  const brokerRefs = useRef(new Map<string, HTMLElement>())
  const [anchors, setAnchors] = useState<{
    channels: Record<string, Anchor>
    brokers: Record<string, Anchor>
  }>({ channels: {}, brokers: {} })
  const dragRef = useRef<
    | { kind: 'connect'; channelId: string; overBrokerId: string | null }
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
  const binRef = useRef<HTMLDivElement>(null)
  const cardDragRef = useRef<CardDrag | null>(null)
  const [cardDrag, setCardDrag] = useState<CardDrag | null>(null)
  const cardPointer = useCardPointerSession()

  const connections = useMemo(() => {
    const linked = [
      ...brokers.flatMap(broker =>
        normalizeSignalChannelIds(broker.signal_channel_ids).map(channelId => ({
          brokerId: broker.id,
          channelId,
        })),
      ),
      ...brokerLinks.map(link => ({
        brokerId: link.destinationId,
        channelId: link.sourceId,
      })),
    ]
    if (!pendingLink) return linked
    const exists = linked.some(item =>
      item.brokerId === pendingLink.brokerId && item.channelId === pendingLink.channelId,
    )
    return exists ? linked : [...linked, pendingLink]
  }, [brokers, brokerLinks, pendingLink])

  const brokerUnderPointer = (clientX: number, clientY: number, reach = 20): string | null => {
    let found: string | null = null
    let best = Number.POSITIVE_INFINITY
    brokerRefs.current.forEach((el, id) => {
      const rect = el.getBoundingClientRect()
      const inside = clientX >= rect.left - reach
        && clientX <= rect.right + 24
        && clientY >= rect.top - 40
        && clientY <= rect.bottom + 40
      if (!inside) return
      const distance = Math.abs(clientY - (rect.top + rect.height / 2))
      if (distance < best) {
        best = distance
        found = id
      }
    })
    return found
  }

  const brokerConnectTarget = (clientX: number, clientY: number) => brokerUnderPointer(clientX, clientY, 220)

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
    const overBrokerId = brokerConnectTarget(event.clientX, event.clientY)
    dragRef.current = { kind: 'connect', channelId, overBrokerId }
    const pointer = pointerInMap(event.clientX, event.clientY)
    if (!pointer) return
    setDrag({
      kind: 'connect',
      channelId,
      pointer,
      overBrokerId,
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
      const overBrokerId = brokerConnectTarget(event.clientX, event.clientY)
      current.overBrokerId = overBrokerId
      setDrag({
        kind: 'connect',
        channelId: current.channelId,
        pointer,
        overBrokerId,
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
    const brokerId = brokerConnectTarget(event.clientX, event.clientY) ?? current.overBrokerId
    if (!brokerId) return
    const alreadyLinked = connections.some(item =>
      item.brokerId === brokerId && item.channelId === current.channelId,
    )
    if (alreadyLinked) return
    setPendingLink({ channelId: current.channelId, brokerId })
    void onConnect(current.channelId, brokerId).finally(() => setPendingLink(null))
  }

  const onPortPointerCancel = () => {
    dragRef.current = null
    setDrag(null)
  }

  const pointerOverBin = (clientX: number, clientY: number) => {
    const bin = binRef.current
    if (!bin) return false
    const rect = bin.getBoundingClientRect()
    return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
  }

  const itemUnderPointer = (
    refs: Map<string, HTMLElement>,
    clientX: number,
    clientY: number,
    ignoreId: string,
  ) => {
    let found: string | null = null
    refs.forEach((el, id) => {
      if (id === ignoreId) return
      const rect = el.getBoundingClientRect()
      if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
        found = id
      }
    })
    return found
  }

  const onCardPointerDown = (
    kind: CardDrag['kind'],
    id: string,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0) return
    if ((event.target as HTMLElement).closest('button')) return
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const next = {
      kind,
      id,
      overBin: false,
      x: event.clientX,
      y: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: rect.width,
    }
    cardDragRef.current = next
    setCardDrag(next)
    cardPointer.begin()
  }

  const onCardPointerMove = (event: { clientX: number; clientY: number }) => {
    const current = cardDragRef.current
    if (!current) return
    const overBin = pointerOverBin(event.clientX, event.clientY)
    const next = { ...current, x: event.clientX, y: event.clientY, overBin }
    cardDragRef.current = next
    setCardDrag(next)
    if (overBin) return
    const refs = isLeftDrag(current.kind) ? channelRefs.current : brokerRefs.current
    const ids = isLeftDrag(current.kind) ? linkedChannelIds : brokers.map(broker => broker.id)
    const targetId = itemUnderPointer(refs, event.clientX, event.clientY, current.id)
    if (!targetId) return
    const rect = refs.get(targetId)?.getBoundingClientRect()
    if (!rect) return
    const reordered = reorderList(ids, current.id, targetId, event.clientY > rect.top + rect.height / 2)
    if (sameOrder(reordered, ids)) return
    if (isLeftDrag(current.kind)) onReorderChannels(reordered)
    else onReorderBrokers(reordered)
  }

  const onCardPointerUp = (event: { clientX: number; clientY: number }) => {
    cardPointer.stop()
    const current = cardDragRef.current
    cardDragRef.current = null
    const overBin = current != null && pointerOverBin(event.clientX, event.clientY)
    setCardDrag(null)
    if (overBin && current) {
      if (current.kind === 'source') onRemoveSource(current.id)
      else if (current.kind === 'broker') onRemoveDestination(current.id)
      else onRemoveChannel(current.id)
    }
  }

  const onCardPointerCancel = () => {
    cardPointer.stop()
    cardDragRef.current = null
    setCardDrag(null)
  }

  cardPointer.moveRef.current = onCardPointerMove
  cardPointer.endRef.current = onCardPointerUp

  const layoutKey = `${linkedChannelIds.join(',')}|${brokers.map(broker => broker.id).join(',')}|${connections.map(item => `${item.channelId}:${item.brokerId}`).join(',')}|${cardDrag?.id ?? ''}`

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
    channelRefs.current.forEach(el => observer.observe(el))
    brokerRefs.current.forEach(el => observer.observe(el))
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
        const brokerAnchor = drag.overBrokerId ? anchors.brokers[drag.overBrokerId] : null
        return connectorGeometry(start, brokerAnchor ?? drag.pointer)
      })()
    : null

  const curves = (() => {
    const seen = new Set<string>()
    const ready = connections.flatMap(connection => {
      const pairKey = `${connection.channelId}:${connection.brokerId}`
      if (seen.has(pairKey)) return []
      seen.add(pairKey)
      if (pendingUnlink?.channelId === connection.channelId && pendingUnlink.brokerId === connection.brokerId) return []
      const startAnchor = anchors.channels[connection.channelId]
      const endAnchor = anchors.brokers[connection.brokerId]
      if (!startAnchor || !endAnchor) return []
      return [{ ...connection, startAnchor, endAnchor }]
    })
    const channelsByBroker = new Map<string, string[]>()
    for (const connection of ready) {
      const channelIds = channelsByBroker.get(connection.brokerId) ?? []
      channelIds.push(connection.channelId)
      channelsByBroker.set(connection.brokerId, channelIds)
    }
    const yOfChannel = (id: string) => anchors.channels[id]?.y ?? 0
    channelsByBroker.forEach((ids, brokerId) => {
      channelsByBroker.set(brokerId, [...ids].sort((a, b) => yOfChannel(a) - yOfChannel(b) || a.localeCompare(b)))
    })
    const routed = ready.map(connection => {
      const brokerMates = channelsByBroker.get(connection.brokerId) ?? [connection.channelId]
      const start = { x: connection.startAnchor.x, y: connection.startAnchor.y }
      const end = {
        x: connection.endAnchor.x,
        y: spreadAnchorY(
          connection.endAnchor.y,
          connection.endAnchor.height,
          Math.max(0, brokerMates.indexOf(connection.channelId)),
          brokerMates.length,
        ),
      }
      return { ...connection, start, end }
    })
    const gears = placeConnectionGears(routed)
    return routed.map((connection, index) => ({
      ...connection,
      ...curveThrough(connection.start, connection.end, gears[index]),
    }))
  })()

  return (
    <div
      ref={mapRef}
      dir="ltr"
      className="relative hidden lg:grid lg:grid-cols-[minmax(220px,1fr)_168px_minmax(220px,1fr)] lg:items-start"
    >
      <div className="flex flex-col gap-3">
        <SectionLabel label={copy.copyFrom} />
        {linkedChannelIds.map(channelId => {
          const source = sources.find(broker => broker.id === channelId)
          const dragging = isLeftDrag(cardDrag?.kind ?? 'broker') && cardDrag?.id === channelId
          const name = source
            ? getBrokerDisplayLabel(source)
            : channelDisplayName(channelById.get(channelId), copy.unknownChannel)
          return (
            <div
              key={channelId}
              ref={el => {
                if (el) channelRefs.current.set(channelId, el)
                else channelRefs.current.delete(channelId)
              }}
              className={dragSlotClass(dragging)}
              onPointerDown={event => onCardPointerDown(source ? 'source' : 'channel', channelId, event)}
              onPointerUp={onCardPointerUp}
              onPointerCancel={onCardPointerCancel}
            >
              <div className="relative min-h-0">
                {source ? <BrokerNode broker={source} copy={copy} linked master /> : (
                  <ChannelNode channel={channelById.get(channelId)} name={name} copy={copy} />
                )}
                <button
                  type="button"
                  className="absolute end-0 top-1/2 z-30 h-3.5 w-3.5 -translate-y-1/2 translate-x-1/2 cursor-grab touch-none rounded-full bg-teal-500 ring-2 ring-white hover:scale-110 active:cursor-grabbing dark:ring-neutral-950"
                  aria-label={interpolate(copy.dragToConnect, { channel: name })}
                  onPointerDown={event => onPortPointerDown(channelId, event)}
                  onPointerMove={onPortPointerMove}
                  onPointerUp={onPortPointerUp}
                  onPointerCancel={onPortPointerCancel}
                />
              </div>
            </div>
          )
        })}
        {cardDrag && isLeftDrag(cardDrag.kind) ? (
          <div
            ref={binRef}
            role="img"
            aria-label={removeDragLabel(cardDrag.kind, copy)}
            className={`flex items-center justify-center gap-2 rounded-2xl border border-dashed px-4 py-4 text-sm font-medium ${
              cardDrag.overBin
                ? 'border-error-500 bg-error-50 text-error-600 dark:bg-error-950/40 dark:text-error-400'
                : 'border-neutral-300 text-neutral-500 dark:border-neutral-700 dark:text-neutral-400'
            }`}
          >
            <Trash2 className="h-5 w-5" />
            {removeDragLabel(cardDrag.kind, copy)}
          </div>
        ) : null}
        <AddSectionAction label={copy.addChannel} onClick={onAddChannel} />
      </div>
      <div />
      <div className="flex flex-col gap-3">
        <SectionLabel label={copy.copyTo} />
        {brokers.map(broker => {
          const dragging = cardDrag?.kind === 'broker' && cardDrag.id === broker.id
          const connectTarget = (drag?.kind === 'connect' && drag.overBrokerId === broker.id)
            || (drag?.kind === 'disconnect' && drag.brokerId === broker.id && drag.overBroker)
          return (
            <div
              key={broker.id}
              ref={el => {
                if (el) brokerRefs.current.set(broker.id, el)
                else brokerRefs.current.delete(broker.id)
              }}
              className={dragSlotClass(dragging)}
              onPointerDown={event => onCardPointerDown('broker', broker.id, event)}
              onPointerUp={onCardPointerUp}
              onPointerCancel={onCardPointerCancel}
            >
              <div className={`relative min-h-0 rounded-2xl ${connectTarget ? 'ring-2 ring-teal-500' : ''}`}>
                {normalizeSignalChannelIds(broker.signal_channel_ids).length === 0
                  && !brokerLinks.some(link => link.destinationId === broker.id) ? (
                  <span className="absolute start-0 top-1/2 z-30 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-teal-500 ring-2 ring-white dark:ring-neutral-950" />
                ) : null}
                <BrokerNode broker={broker} copy={copy} />
              </div>
            </div>
          )
        })}
        {cardDrag?.kind === 'broker' ? (
          <div
            ref={binRef}
            role="img"
            aria-label={copy.removeDestination}
            className={`flex items-center justify-center gap-2 rounded-2xl border border-dashed px-4 py-4 text-sm font-medium ${
              cardDrag.overBin
                ? 'border-error-500 bg-error-50 text-error-600 dark:bg-error-950/40 dark:text-error-400'
                : 'border-neutral-300 text-neutral-500 dark:border-neutral-700 dark:text-neutral-400'
            }`}
          >
            <Trash2 className="h-5 w-5" />
            {copy.removeDestination}
          </div>
        ) : null}
        <AddSectionAction label={copy.addDestination} onClick={onAddBroker} />
      </div>

      <div
        className="pointer-events-none absolute inset-0 z-20"
        style={{ gridColumn: '1 / -1', gridRow: '1 / -1' }}
      >
      <svg className="absolute inset-0 h-full w-full overflow-visible" aria-hidden>
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
            strokeDasharray={drag?.kind === 'connect' && drag.overBrokerId ? undefined : '6 4'}
            className={
              drag?.kind === 'disconnect' && !drag.overBroker
                ? 'text-error-500'
                : 'text-teal-500'
            }
          />
        ) : null}
      </svg>

      {curves.filter(curve => !(
        drag?.kind === 'disconnect'
        && drag.channelId === curve.channelId
        && drag.brokerId === curve.brokerId
      )).map(curve => {
        const broker = brokers.find(item => item.id === curve.brokerId)
        const source = sources.find(item => item.id === curve.channelId)
        const channelName = source
          ? getBrokerDisplayLabel(source)
          : channelDisplayName(channelById.get(curve.channelId), copy.unknownChannel)
        return (
          <button
            key={`${curve.channelId}:${curve.brokerId}`}
            type="button"
            className="pointer-events-auto absolute z-40 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-teal-200 bg-white text-teal-700 shadow-sm hover:bg-teal-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 dark:border-teal-800 dark:bg-neutral-950 dark:text-teal-300 dark:hover:bg-teal-950"
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
        const source = sources.find(item => item.id === curve.channelId)
        const channelName = source
          ? getBrokerDisplayLabel(source)
          : channelDisplayName(channelById.get(curve.channelId), copy.unknownChannel)
        return (
          <button
            key={`end:${curve.channelId}:${curve.brokerId}`}
            type="button"
            className="pointer-events-auto absolute z-40 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none rounded-full bg-teal-500 ring-2 ring-white hover:scale-110 active:cursor-grabbing dark:ring-neutral-950"
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
      {cardDrag ? (
        <CardDragGhost drag={cardDrag}>
          {draggedCard(cardDrag, brokers, sources, channelById, copy)}
        </CardDragGhost>
      ) : null}
    </div>
  )
}

function ConfigurationStack({
  brokers,
  sources,
  brokerLinks,
  linkedChannelIds,
  channelById,
  copy,
  onOpen,
  onAddChannel,
  onAddBroker,
  onReorderChannels,
  onReorderBrokers,
  onRemoveChannel,
  onRemoveSource,
  onRemoveDestination,
}: {
  brokers: BrokerAccount[]
  sources: BrokerAccount[]
  brokerLinks: { sourceId: string; destinationId: string }[]
  linkedChannelIds: string[]
  channelById: Map<string, ChannelName>
  copy: ConfigurationsPageTranslations
  onOpen: (pair: PairSelection) => void
  onAddChannel: () => void
  onAddBroker: () => void
  onReorderChannels: (ids: string[]) => void
  onReorderBrokers: (ids: string[]) => void
  onRemoveChannel: (channelId: string) => void
  onRemoveSource: (brokerId: string) => void
  onRemoveDestination: (brokerId: string) => void
}) {
  const channelRefs = useRef(new Map<string, HTMLElement>())
  const brokerRefs = useRef(new Map<string, HTMLElement>())
  const binRef = useRef<HTMLDivElement>(null)
  const cardDragRef = useRef<CardDrag | null>(null)
  const [cardDrag, setCardDrag] = useState<CardDrag | null>(null)
  const cardPointer = useCardPointerSession()
  const unlinked = brokers.filter(broker =>
    normalizeSignalChannelIds(broker.signal_channel_ids).length === 0
    && !brokerLinks.some(link => link.destinationId === broker.id),
  )

  const pointerOverBin = (clientX: number, clientY: number) => {
    const bin = binRef.current
    if (!bin) return false
    const rect = bin.getBoundingClientRect()
    return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
  }

  const itemUnderPointer = (
    refs: Map<string, HTMLElement>,
    clientX: number,
    clientY: number,
    ignoreId: string,
  ) => {
    let found: string | null = null
    refs.forEach((el, id) => {
      if (id === ignoreId) return
      const rect = el.getBoundingClientRect()
      if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
        found = id
      }
    })
    return found
  }

  const onCardPointerDown = (
    kind: CardDrag['kind'],
    id: string,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0) return
    if ((event.target as HTMLElement).closest('button')) return
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const next = {
      kind,
      id,
      overBin: false,
      x: event.clientX,
      y: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: rect.width,
    }
    cardDragRef.current = next
    setCardDrag(next)
    cardPointer.begin()
  }

  const onCardPointerMove = (event: { clientX: number; clientY: number }) => {
    const current = cardDragRef.current
    if (!current) return
    const overBin = pointerOverBin(event.clientX, event.clientY)
    const next = { ...current, x: event.clientX, y: event.clientY, overBin }
    cardDragRef.current = next
    setCardDrag(next)
    if (overBin) return
    const refs = isLeftDrag(current.kind) ? channelRefs.current : brokerRefs.current
    const ids = isLeftDrag(current.kind) ? linkedChannelIds : brokers.map(broker => broker.id)
    const targetId = itemUnderPointer(refs, event.clientX, event.clientY, current.id)
    if (!targetId) return
    const rect = refs.get(targetId)?.getBoundingClientRect()
    if (!rect) return
    const reordered = reorderList(ids, current.id, targetId, event.clientY > rect.top + rect.height / 2)
    if (sameOrder(reordered, ids)) return
    if (isLeftDrag(current.kind)) onReorderChannels(reordered)
    else onReorderBrokers(reordered)
  }

  const onCardPointerUp = (event: { clientX: number; clientY: number }) => {
    cardPointer.stop()
    const current = cardDragRef.current
    cardDragRef.current = null
    const overBin = current != null && pointerOverBin(event.clientX, event.clientY)
    setCardDrag(null)
    if (overBin && current) {
      if (current.kind === 'source') onRemoveSource(current.id)
      else if (current.kind === 'broker') onRemoveDestination(current.id)
      else onRemoveChannel(current.id)
    }
  }

  const onCardPointerCancel = () => {
    cardPointer.stop()
    cardDragRef.current = null
    setCardDrag(null)
  }

  cardPointer.moveRef.current = onCardPointerMove
  cardPointer.endRef.current = onCardPointerUp

  return (
    <div className="flex flex-col gap-6 lg:hidden">
      <SectionLabel label={copy.copyFrom} />
      {linkedChannelIds.map(channelId => {
        const source = sources.find(broker => broker.id === channelId)
        const name = source
          ? getBrokerDisplayLabel(source)
          : channelDisplayName(channelById.get(channelId), copy.unknownChannel)
        const linkedBrokers = source
          ? brokers.filter(broker => brokerLinks.some(link =>
            link.sourceId === channelId && link.destinationId === broker.id,
          ))
          : brokers.filter(broker =>
            normalizeSignalChannelIds(broker.signal_channel_ids).includes(channelId),
          )
        const draggingChannel = isLeftDrag(cardDrag?.kind ?? 'broker') && cardDrag?.id === channelId
        return (
          <div key={channelId}>
            <div
              ref={el => {
                if (el) channelRefs.current.set(channelId, el)
                else channelRefs.current.delete(channelId)
              }}
              className={dragSlotClass(draggingChannel)}
              onPointerDown={event => onCardPointerDown(source ? 'source' : 'channel', channelId, event)}
              onPointerUp={onCardPointerUp}
              onPointerCancel={onCardPointerCancel}
            >
              <div className="min-h-0">
                {source ? <BrokerNode broker={source} copy={copy} linked master /> : (
                  <ChannelNode channel={channelById.get(channelId)} name={name} copy={copy} />
                )}
              </div>
            </div>
            {linkedBrokers.map(broker => {
              const draggingBroker = cardDrag?.kind === 'broker' && cardDrag.id === broker.id
              return (
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
                  <div
                    ref={el => {
                      if (el) brokerRefs.current.set(broker.id, el)
                      else brokerRefs.current.delete(broker.id)
                    }}
                    className={`w-full ${dragSlotClass(draggingBroker)}`}
                    onPointerDown={event => onCardPointerDown('broker', broker.id, event)}
                    onPointerUp={onCardPointerUp}
                    onPointerCancel={onCardPointerCancel}
                  >
                    <div className="min-h-0 w-full">
                      <BrokerNode broker={broker} copy={copy} />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )
      })}
      {cardDrag && isLeftDrag(cardDrag.kind) ? (
        <div
          ref={binRef}
          role="img"
          aria-label={removeDragLabel(cardDrag.kind, copy)}
          className={`flex items-center justify-center gap-2 rounded-2xl border border-dashed px-4 py-4 text-sm font-medium ${
            cardDrag.overBin
              ? 'border-error-500 bg-error-50 text-error-600 dark:bg-error-950/40 dark:text-error-400'
              : 'border-neutral-300 text-neutral-500 dark:border-neutral-700 dark:text-neutral-400'
          }`}
        >
          <Trash2 className="h-5 w-5" />
          {removeDragLabel(cardDrag.kind, copy)}
        </div>
      ) : null}
      <AddSectionAction label={copy.addChannel} onClick={onAddChannel} />
      <SectionLabel label={copy.copyTo} />
      {unlinked.map(broker => {
        const dragging = cardDrag?.kind === 'broker' && cardDrag.id === broker.id
        return (
          <div
            key={broker.id}
            ref={el => {
              if (el) brokerRefs.current.set(broker.id, el)
              else brokerRefs.current.delete(broker.id)
            }}
            className={dragSlotClass(dragging)}
            onPointerDown={event => onCardPointerDown('broker', broker.id, event)}
            onPointerUp={onCardPointerUp}
            onPointerCancel={onCardPointerCancel}
          >
            <div className="min-h-0">
              <BrokerNode broker={broker} copy={copy} />
            </div>
          </div>
        )
      })}
      {cardDrag?.kind === 'broker' ? (
        <div
          ref={binRef}
          role="img"
          aria-label={copy.removeDestination}
          className={`flex items-center justify-center gap-2 rounded-2xl border border-dashed px-4 py-4 text-sm font-medium ${
            cardDrag.overBin
              ? 'border-error-500 bg-error-50 text-error-600 dark:bg-error-950/40 dark:text-error-400'
              : 'border-neutral-300 text-neutral-500 dark:border-neutral-700 dark:text-neutral-400'
          }`}
        >
          <Trash2 className="h-5 w-5" />
          {copy.removeDestination}
        </div>
      ) : null}
      <AddSectionAction label={copy.addDestination} onClick={onAddBroker} />
      {cardDrag ? (
        <CardDragGhost drag={cardDrag}>
          {draggedCard(cardDrag, brokers, sources, channelById, copy)}
        </CardDragGhost>
      ) : null}
    </div>
  )
}

function SectionLabel({ label }: { label: string }) {
  return (
    <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400">{label}</p>
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

function channelUsernameLabel(username: string | undefined): string {
  const handle = username?.trim().replace(/^@/, '') ?? ''
  return handle ? `@${handle}` : '—'
}

function ChannelLogo({ username }: { username: string }) {
  const [failed, setFailed] = useState(false)
  const handle = username.trim().replace(/^@/, '')
  if (!handle || failed) return <TelegramLogo />
  return (
    <img
      src={`https://t.me/i/userpic/320/${encodeURIComponent(handle)}.jpg`}
      alt=""
      referrerPolicy="no-referrer"
      className="h-10 w-10 shrink-0 rounded-full object-cover"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  )
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-neutral-500 dark:text-neutral-400">{label}</dt>
      <dd dir="auto" className="min-w-0 truncate text-end text-neutral-800 dark:text-neutral-200">{value}</dd>
    </div>
  )
}

function ChannelNode({
  channel,
  name,
  copy,
}: {
  channel?: ChannelName
  name: string
  copy: ConfigurationsPageTranslations
}) {
  const username = channelUsernameLabel(channel?.channel_username)
  const channelId = channel?.channel_id?.trim() || '—'
  const subscribers = channel?.subscriber_count == null
    ? '—'
    : channel.subscriber_count.toLocaleString()
  return (
    <Card padding="sm">
      <div className="flex items-start gap-3">
        <ChannelLogo key={username} username={channel?.channel_username ?? ''} />
        <div className="min-w-0 flex-1">
          <p dir="auto" className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-50">{name}</p>
          <dl className="mt-1.5 space-y-0.5 text-xs">
            <MetaRow label={copy.username} value={username} />
            <MetaRow label={copy.channelId} value={channelId} />
            <MetaRow label={copy.subscribers} value={subscribers} />
          </dl>
        </div>
      </div>
    </Card>
  )
}

function BrokerNode({
  broker,
  copy,
  linked: linkedOverride,
  master = false,
}: {
  broker: BrokerAccount
  copy: ConfigurationsPageTranslations
  linked?: boolean
  master?: boolean
}) {
  const login = broker.account_login?.trim() || '—'
  const linked = linkedOverride ?? normalizeSignalChannelIds(broker.signal_channel_ids).length > 0
  const accountTypeLabels: LinkedAccountTypeLabels = {
    live: copy.accountTypeLive,
    demo: copy.accountTypeDemo,
    propFirm: copy.accountTypePropFirm,
  }
  const accountType = formatLinkedAccountTypeLabel(
    resolveLinkedAccountTypeForBroker(broker),
    accountTypeLabels,
  )
  const currency = broker.last_currency
  return (
    <Card padding="sm">
      <div className="flex min-w-0 items-start gap-3">
        <PlatformLogo platform={broker.platform} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{broker.label}</h2>
            <Badge variant="neutral" size="sm">{broker.platform}</Badge>
            {master ? (
              <Badge variant="primary" size="sm">{copy.master}</Badge>
            ) : (
              <Badge variant={broker.is_active ? 'success' : 'neutral'} size="sm">
                {broker.is_active ? copy.copyingOn : copy.copyingOff}
              </Badge>
            )}
          </div>
          <dl className="mt-1.5 space-y-0.5 text-xs">
            <MetaRow label={copy.login} value={login} />
            <MetaRow label={copy.balance} value={formatMoneyWithCode(resolveBrokerTotalBalance(broker), currency)} />
            <MetaRow label={copy.equity} value={formatMoneyWithCode(broker.last_equity, currency)} />
            <MetaRow label={copy.accountType} value={accountType} />
          </dl>
          {linked ? null : (
            <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{copy.noChannelsLinked}</p>
          )}
        </div>
      </div>
    </Card>
  )
}

function withChannelSettings(
  rows: BrokerChannelTradingConfigRow[],
  brokerId: string,
  channelId: string,
  settings: ManualSettings,
  copierMode: 'ai' | 'manual',
  aiSettings: Json,
): BrokerChannelTradingConfigRow[] {
  const index = rows.findIndex(row =>
    row.broker_account_id === brokerId && row.channel_id.toLowerCase() === channelId,
  )
  if (index < 0) {
    return [...rows, {
      id: `local-${brokerId}-${channelId}`,
      broker_account_id: brokerId,
      channel_id: channelId,
      copier_mode: copierMode,
      manual_settings: settings,
      ai_settings: aiSettings,
      updated_at: new Date().toISOString(),
    }]
  }
  return rows.map((row, rowIndex) => (
    rowIndex === index ? { ...row, manual_settings: settings, copier_mode: copierMode } : row
  ))
}

function ConfigurationModal({
  broker,
  sourceBroker,
  channelId,
  channelName,
  settings,
  copy,
  modalCopy,
  closeLabel,
  multiTradeEnabled,
  saveError,
  onPatch,
  onError,
  onClose,
}: {
  broker: BrokerAccount
  sourceBroker: BrokerAccount | null
  channelId: string
  channelName: string
  settings: ManualSettings | null
  copy: ConfigurationsPageTranslations
  modalCopy: ConfigureModalTranslations
  closeLabel: string
  multiTradeEnabled: boolean
  saveError: string | null
  onPatch: (patch: Partial<ManualSettings>) => void
  onError: (message: string) => void
  onClose: () => void
}) {
  const resolved = settings ?? resolveChannelTradingConfig(broker, channelId).manual_settings
  const sourceName = sourceBroker ? getBrokerDisplayLabel(sourceBroker) : channelName

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
              {sourceBroker ? <PlatformLogo platform={sourceBroker.platform} /> : <TelegramLogo />}
              <span className="truncate">{sourceName}</span>
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
          <ConfigurationSettingsEditor
            broker={broker}
            settings={resolved}
            copy={copy}
            modalCopy={modalCopy}
            multiTradeEnabled={multiTradeEnabled}
            saveError={saveError}
            onPatch={onPatch}
            onError={onError}
          />
        </div>
        <div className="flex justify-end gap-2 border-t border-neutral-100 px-5 py-4 dark:border-neutral-800">
          <button
            type="button"
            className="rounded-lg px-4 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
            onClick={onClose}
          >
            {closeLabel}
          </button>
          {sourceBroker ? null : (
            <Link
              to={`/brokers?configure=${encodeURIComponent(broker.id)}&channel=${encodeURIComponent(channelId)}`}
              className="inline-flex items-center justify-center rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700"
            >
              {copy.edit}
            </Link>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}


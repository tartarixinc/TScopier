import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import clsx from 'clsx'
import { Plus, RefreshCw, Trash2, X } from 'lucide-react'
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
import {
  addDiscordChannel,
  discordClientId,
  discordInviteUrl,
  discordRedirectUri,
  removeDiscordChannel,
  saveDiscordInstallation,
  setDiscordChannelActive,
  subscribeDiscordSourcesChanged,
  syncDiscordGuild,
} from '../../lib/discordSource'
import { planLimitErrorMessage } from '../../lib/telegramChannelApi'
import type { BrokerAccount } from '../../types/database'
import { Card } from '../ui/Card'
import { Button } from '../ui/Button'
import { Toggle } from '../ui/Toggle'
import { Badge } from '../ui/Badge'

type Installation = { id: string; guild_id: string; guild_name: string }
type GuildChannel = { guild_id: string; discord_channel_id: string; name: string }
type SelectedChannel = {
  id: string
  installation_id: string
  guild_id: string
  discord_channel_id: string
  name: string
  channel_id: string
  is_active: boolean
}

export function DiscordSourcePanel({
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
  const [searchParams, setSearchParams] = useSearchParams()
  const guildFromInvite = searchParams.get('guild_id')
  const [installations, setInstallations] = useState<Installation[]>([])
  const [available, setAvailable] = useState<GuildChannel[]>([])
  const [channels, setChannels] = useState<SelectedChannel[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState('')
  const [connectMenuId, setConnectMenuId] = useState<string | null>(null)
  const [connectingBrokerId, setConnectingBrokerId] = useState<string | null>(null)
  const [connectingAllId, setConnectingAllId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const inviteHandled = useRef<string | null>(null)

  const load = useCallback(async () => {
    if (!user?.id) {
      setInstallations([])
      setAvailable([])
      setChannels([])
      setLoading(false)
      return
    }
    const [installRes, channelRes] = await Promise.all([
      supabase.from('discord_installations').select('id, guild_id, guild_name').eq('user_id', user.id).order('created_at', { ascending: true }),
      supabase.from('discord_channels').select('id, installation_id, guild_id, discord_channel_id, name, channel_id, is_active').eq('user_id', user.id).order('created_at', { ascending: true }),
    ])
    if (installRes.error) setError(installRes.error.message)
    const installs = (installRes.data ?? []) as Installation[]
    setInstallations(installs)
    setChannels((channelRes.data ?? []) as SelectedChannel[])
    const guildIds = installs.map(row => row.guild_id)
    if (guildIds.length === 0) {
      setAvailable([])
      setLoading(false)
      return
    }
    const guildRes = await supabase
      .from('discord_guild_channels')
      .select('guild_id, discord_channel_id, name')
      .in('guild_id', guildIds)
      .order('name', { ascending: true })
    if (!guildRes.error) setAvailable((guildRes.data ?? []) as GuildChannel[])
    setLoading(false)
  }, [user?.id])

  useEffect(() => {
    void load()
    return subscribeDiscordSourcesChanged(() => { void load() })
  }, [load])

  useEffect(() => {
    if (!user?.id || !guildFromInvite || inviteHandled.current === guildFromInvite) return
    inviteHandled.current = guildFromInvite
    void (async () => {
      const saved = await saveDiscordInstallation(supabase, user.id, guildFromInvite)
      if (saved.error) setError(saved.error)
      else {
        const synced = await syncDiscordGuild(supabase, guildFromInvite)
        if (synced.error) setError(synced.error)
      }
      const next = new URLSearchParams(searchParams)
      next.delete('guild_id')
      next.delete('code')
      next.delete('permissions')
      setSearchParams(next, { replace: true })
      await load()
    })()
  }, [guildFromInvite, load, searchParams, setSearchParams, user?.id])

  const guildName = useCallback((guildId: string) => {
    return installations.find(row => row.guild_id === guildId)?.guild_name || guildId
  }, [installations])

  const selectedKeys = useMemo(
    () => new Set(channels.map(row => `${row.guild_id}:${row.discord_channel_id}`)),
    [channels],
  )
  const unselected = available.filter(row => !selectedKeys.has(`${row.guild_id}:${row.discord_channel_id}`))

  const connect = () => {
    const clientId = discordClientId()
    if (!clientId) {
      setError(copy.discordClientMissing)
      return
    }
    window.open(discordInviteUrl(clientId, discordRedirectUri()), '_blank', 'noopener,noreferrer')
  }

  const refreshGuilds = async () => {
    if (!user?.id || installations.length === 0) return
    setSyncing(true)
    setError('')
    for (const install of installations) {
      const synced = await syncDiscordGuild(supabase, install.guild_id)
      if (synced.error) setError(synced.error)
    }
    await load()
    setSyncing(false)
  }

  const addChannel = async (row: GuildChannel) => {
    if (!user?.id) return
    if (!canAddChannel()) {
      setError(interpolate(t.pricing.paywall.channelLimit, { limit: String(limits.maxTelegramChannels ?? 5) }))
      return
    }
    const install = installations.find(item => item.guild_id === row.guild_id)
    if (!install) return
    setBusyId(row.discord_channel_id)
    setError('')
    const result = await addDiscordChannel(supabase, user.id, {
      installationId: install.id,
      guildId: row.guild_id,
      discordChannelId: row.discord_channel_id,
      name: row.name,
    })
    setBusyId(null)
    if (result.error) {
      setError(planLimitErrorMessage(result.error))
      return
    }
    void refreshSubscription()
    await load()
  }

  if (loading && installations.length === 0) {
    return <Card><p className="py-8 text-center text-sm text-neutral-500 dark:text-neutral-400">{t.common.loading}</p></Card>
  }

  if (installations.length === 0) {
    const steps = [copy.discordHow1, copy.discordHow2, copy.discordHow3]
    return (
      <Card className="overflow-hidden" padding="none">
        <div className="relative border-b border-neutral-100 bg-gradient-to-br from-neutral-200/80 via-neutral-50 to-white px-5 pb-5 pt-6 dark:border-neutral-800 dark:from-[#2a2e39] dark:via-[#1e222d] dark:to-neutral-950 sm:px-6 sm:pt-7">
          <div className="mx-auto flex max-w-md flex-col items-center text-center">
            <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl border border-neutral-100 bg-white shadow-md dark:border-neutral-700 dark:bg-neutral-800">
              <img src="/discord-logo.png" alt="" className="h-10 w-10 rounded-full object-cover" loading="lazy" aria-hidden />
            </div>
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">{copy.discordHeroTitle}</h2>
            <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">{copy.discordHeroSubtitle}</p>
          </div>
        </div>
        <div className="mx-auto max-w-md px-5 py-5 sm:px-6 sm:py-6">
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
          {error ? <p className="mb-4 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
          <Button size="lg" className="w-full" onClick={connect}>
            <img src="/discord-logo.png" alt="" className="h-5 w-5 rounded-full object-cover" loading="lazy" aria-hidden />
            {copy.discordConnect}
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
            <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{copy.discordListTitle}</h2>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">{interpolate(ce.configuredCount, { count: String(channels.length) })}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => void refreshGuilds()} loading={syncing}>
              <RefreshCw className="h-3.5 w-3.5" />
              {copy.discordSync}
            </Button>
            <Button size="sm" onClick={connect}>
              <Plus className="h-3.5 w-3.5" />
              {copy.discordConnect}
            </Button>
          </div>
        </div>
        {error ? <p className="px-4 pt-3 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
        {channels.length === 0 ? (
          <p className="px-4 py-6 text-sm text-neutral-500 dark:text-neutral-400">{copy.discordEmptyChannels}</p>
        ) : (
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {channels.map(channel => (
              <DiscordChannelRow
                key={channel.id}
                channel={channel}
                guildLabel={guildName(channel.guild_id)}
                brokers={brokers}
                menuOpen={connectMenuId === channel.id}
                connectingBrokerId={connectingBrokerId}
                connectingAll={connectingAllId === channel.id}
                onToggleMenu={() => setConnectMenuId(current => current === channel.id ? null : channel.id)}
                onCloseMenu={() => setConnectMenuId(null)}
                onConnectBroker={async brokerId => {
                  const broker = brokers.find(item => item.id === brokerId)
                  if (!broker || !user?.id) return
                  setConnectingBrokerId(brokerId)
                  const result = await connectChannelToBroker(supabase, user.id, broker, channel.channel_id)
                  setConnectingBrokerId(null)
                  setConnectMenuId(null)
                  if (result.error) setError(result.error)
                  else if (result.broker) replaceBroker(result.broker)
                }}
                onConnectAll={async () => {
                  if (!user?.id) return
                  setConnectingAllId(channel.id)
                  const result = await linkChannelToAllActiveBrokers(supabase, user.id, channel.channel_id, brokers)
                  setConnectingAllId(null)
                  if (result.error) setError(result.error)
                  for (const broker of result.brokers) replaceBroker(broker)
                }}
                onDisconnect={async brokerId => {
                  const broker = brokers.find(item => item.id === brokerId)
                  if (!broker || !user?.id) return
                  const result = await disconnectChannelFromBroker(supabase, user.id, broker, channel.channel_id)
                  if (result.error) setError(result.error)
                  else if (result.broker) replaceBroker(result.broker)
                }}
                onToggle={async active => {
                  if (!user?.id) return
                  const result = await setDiscordChannelActive(supabase, user.id, channel.id, channel.channel_id, active)
                  if (result.error) setError(result.error)
                  else {
                    setChannels(current => current.map(row => row.id === channel.id ? { ...row, is_active: active } : row))
                    void refreshSubscription()
                  }
                }}
                onDelete={async () => {
                  if (!user?.id) return
                  setBusyId(channel.id)
                  const result = await removeDiscordChannel(supabase, user.id, channel.channel_id, brokers)
                  setBusyId(null)
                  if (result.error) setError(result.error)
                  else {
                    for (const broker of result.brokers) replaceBroker(broker)
                    void refreshSubscription()
                    await load()
                  }
                }}
                deleting={busyId === channel.id}
              />
            ))}
          </ul>
        )}
      </Card>

      <Card padding="none">
        <div className="border-b border-neutral-100 px-4 py-3 dark:border-neutral-800">
          <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{copy.discordPickChannels}</h2>
        </div>
        {unselected.length === 0 ? (
          <p className="px-4 py-6 text-sm text-neutral-500 dark:text-neutral-400">{copy.discordNoTextChannels}</p>
        ) : (
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
            {unselected.map(row => (
              <li key={`${row.guild_id}:${row.discord_channel_id}`} className="flex items-center gap-3 px-4 py-3">
                <img src="/discord-logo.png" alt="" aria-hidden className="h-8 w-8 shrink-0 rounded-full object-cover" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-50">{row.name}</p>
                  <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">{guildName(row.guild_id)}</p>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busyId === row.discord_channel_id}
                  onClick={() => void addChannel(row)}
                >
                  {copy.discordAdd}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

function DiscordChannelRow({
  channel,
  guildLabel,
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
  channel: SelectedChannel
  guildLabel: string
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
  const connected = useMemo(() => brokersMatchingChannel(brokers, channel.channel_id), [brokers, channel.channel_id])
  const availableBrokers = useMemo(() => brokersNotMatchingChannel(brokers, channel.channel_id), [brokers, channel.channel_id])
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
        <img src="/discord-logo.png" alt="" aria-hidden className="h-8 w-8 shrink-0 rounded-full object-cover" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-50">{channel.name}</h3>
            {!channel.is_active ? <Badge variant="neutral" size="sm">{ce.statusPaused}</Badge> : null}
          </div>
          <p className="truncate text-xs text-neutral-500 dark:text-neutral-400">{guildLabel}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Toggle checked={channel.is_active} onChange={onToggle} />
          <button
            type="button"
            onClick={onDelete}
            disabled={deleting}
            className="rounded-lg p-1.5 text-neutral-400 transition-colors hover:bg-error-50 hover:text-error-600 disabled:opacity-50"
            aria-label={interpolate(ce.removeAria, { label: channel.name })}
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
                    aria-label={interpolate(ce.removeBrokerConnectionAria, { broker: label, channel: channel.name })}
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
                aria-label={interpolate(ce.addBrokerConnectionAria, { channel: channel.name })}
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
              {menuOpen ? (
                <BrokerMenu
                  brokers={availableBrokers}
                  emptyLabel={availableBrokers.length === 0 ? ce.connectedBrokers : ce.noBrokersYet}
                  connectingBrokerId={connectingBrokerId}
                  onConnect={onConnectBroker}
                  onClose={onCloseMenu}
                />
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
                <BrokerMenu
                  brokers={availableBrokers}
                  emptyLabel={ce.noBrokersYet}
                  connectingBrokerId={connectingBrokerId}
                  onConnect={onConnectBroker}
                  onClose={onCloseMenu}
                />
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
  emptyLabel,
  connectingBrokerId,
  onConnect,
  onClose,
}: {
  brokers: BrokerAccount[]
  emptyLabel: string
  connectingBrokerId: string | null
  onConnect: (brokerId: string) => void
  onClose: () => void
}) {
  const ce = useT().copierEnginePage
  return (
    <div className="absolute left-0 top-full z-30 mt-1 min-w-[12rem] rounded-lg border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
      {brokers.length === 0 ? (
        <p className="px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400">{emptyLabel}</p>
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

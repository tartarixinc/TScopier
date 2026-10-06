import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { PageHeader } from '../../components/layout/PageHeader'
import { PageShell } from '../../components/layout/PageShell'
import { Badge } from '../../components/ui/Badge'
import { Card } from '../../components/ui/Card'
import { useAuth } from '../../context/AuthContext'
import { useBrokerAccounts } from '../../context/BrokerAccountsContext'
import { useT } from '../../context/LocaleContext'
import { interpolate } from '../../i18n/interpolate'
import type { ConfigureModalTranslations } from '../../i18n/locales/configureModal/types'
import type { ConfigurationsPageTranslations } from '../../i18n/locales/types'
import { normalizeSignalChannelIds } from '../../lib/brokerChannelLink'
import {
  fetchBrokerChannelTradingConfigRowsForBrokers,
  mergeBrokerWithChannelTradingConfigRows,
  type BrokerChannelTradingConfigRow,
} from '../../lib/brokerChannelTradingConfigs'
import { describeChannelConfiguration } from '../../lib/configurationSummary'
import { resolveBrokerTotalBalance } from '../../lib/effectiveBrokerBalance'
import { resolveChannelTradingConfig } from '../../lib/channelTradingConfig'
import { supabase } from '../../lib/supabase'
import type { BrokerAccount } from '../../types/database'

interface ChannelName {
  id: string
  display_name: string
  channel_username: string
}

function PlatformLogo({ platform }: { platform: string }) {
  const [failed, setFailed] = useState(false)
  const key = platform.trim()
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

function channelDisplayName(channel: ChannelName | undefined, fallback: string): string {
  const name = channel?.display_name?.trim()
  if (name) return name
  const username = channel?.channel_username?.trim()
  if (!username) return fallback
  return username.startsWith('@') ? username : `@${username}`
}

export function ConfigurationsPage() {
  const t = useT()
  const copy = t.configurationsPage
  const { user } = useAuth()
  const { brokers, loading: brokersLoading } = useBrokerAccounts()
  const [channels, setChannels] = useState<ChannelName[]>([])
  const [channelsLoading, setChannelsLoading] = useState(true)
  const [configRows, setConfigRows] = useState<BrokerChannelTradingConfigRow[]>([])
  const [configsLoading, setConfigsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

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
      .select('id,display_name,channel_username')
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

  const loading = brokersLoading || channelsLoading || configsLoading

  return (
    <PageShell>
      <PageHeader title={copy.title} />

      {loadError ? (
        <p className="text-sm text-error-600 dark:text-error-400">{copy.loadError}</p>
      ) : null}

      {loading ? (
        <div className="space-y-3" aria-hidden>
          {[0, 1].map(index => (
            <Card key={index} padding="none" className="overflow-hidden">
              <div className="space-y-3 p-4">
                <div className="h-4 w-40 animate-pulse rounded bg-neutral-200 dark:bg-white/10" />
                <div className="h-3 w-56 animate-pulse rounded bg-neutral-100 dark:bg-white/5" />
              </div>
              <div className="space-y-2 border-t border-neutral-100 p-4 dark:border-neutral-800">
                <div className="h-3 w-32 animate-pulse rounded bg-neutral-100 dark:bg-white/5" />
                <div className="flex gap-2">
                  <div className="h-6 w-16 animate-pulse rounded-md bg-neutral-100 dark:bg-white/5" />
                  <div className="h-6 w-24 animate-pulse rounded-md bg-neutral-100 dark:bg-white/5" />
                </div>
              </div>
            </Card>
          ))}
        </div>
      ) : mergedBrokers.length === 0 ? (
        <Card className="text-center">
          <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-50">{copy.emptyTitle}</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-neutral-500 dark:text-neutral-400">{copy.emptyBody}</p>
          <Link
            to="/brokers"
            className="mt-4 inline-flex items-center justify-center rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700"
          >
            {copy.openBrokers}
          </Link>
        </Card>
      ) : (
        <div className="space-y-3">
          {mergedBrokers.map(broker => (
            <BrokerConfigurationCard
              key={broker.id}
              broker={broker}
              channelById={channelById}
              copy={copy}
              modalCopy={t.accountConfig.configureModal}
            />
          ))}
        </div>
      )}
    </PageShell>
  )
}

function BrokerConfigurationCard({
  broker,
  channelById,
  copy,
  modalCopy,
}: {
  broker: BrokerAccount
  channelById: Map<string, ChannelName>
  copy: ConfigurationsPageTranslations
  modalCopy: ConfigureModalTranslations
}) {
  const channelIds = normalizeSignalChannelIds(broker.signal_channel_ids)
  const login = broker.account_login?.trim()

  return (
    <Card padding="none" className="overflow-hidden">
      <div className="flex flex-col gap-2 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
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
        </div>
      </div>

      {channelIds.length === 0 ? (
        <p className="border-t border-neutral-100 px-4 py-3 text-sm text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
          {copy.noChannelsLinked}
        </p>
      ) : (
        <ul className="border-t border-neutral-100 dark:border-neutral-800">
          {channelIds.map(channelId => {
            const channel = channelById.get(channelId)
            const name = channelDisplayName(channel, copy.unknownChannel)
            const resolved = resolveChannelTradingConfig(broker, channelId)
            const sections = describeChannelConfiguration(
              resolved.manual_settings,
              modalCopy,
              copy,
              { accountBalance: resolveBrokerTotalBalance(broker) },
            )
            return (
              <li key={channelId} className="border-t border-neutral-100 first:border-t-0 dark:border-neutral-800">
                <Link
                  to={`/brokers?configure=${encodeURIComponent(broker.id)}&channel=${encodeURIComponent(channelId)}`}
                  aria-label={interpolate(copy.editConfiguration, { channel: name, broker: broker.label })}
                  className="block px-4 py-4 transition-colors hover:bg-primary-50/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 dark:hover:bg-primary-950/25"
                >
                  <p className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{name}</p>
                  <div className="mt-4 space-y-4">
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
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

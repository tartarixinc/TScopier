import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import type { ConfigureModalTranslations } from '../../i18n/locales/configureModal/types'
import type { ConfigurationsPageTranslations } from '../../i18n/locales/types'
import { normalizeSignalChannelIds } from '../../lib/brokerChannelLink'
import { describeChannelConfiguration, type ConfigurationDetailSection } from '../../lib/configurationSummary'
import { resolveBrokerTotalBalance } from '../../lib/effectiveBrokerBalance'
import { resolveChannelTradingConfig } from '../../lib/channelTradingConfig'
import type { BrokerAccount } from '../../types/database'

interface ChannelName {
  id: string
  display_name: string
  channel_username?: string | null
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

export function BrokerConfigurationsModal({
  broker,
  channels,
  loading,
  error,
  copy,
  modalCopy,
  onClose,
  onEdit,
}: {
  broker: BrokerAccount
  channels: ChannelName[]
  loading: boolean
  error: string | null
  copy: ConfigurationsPageTranslations
  modalCopy: ConfigureModalTranslations
  onClose: () => void
  onEdit: () => void
}) {
  const channelById = new Map(channels.map(channel => [channel.id.toLowerCase(), channel]))
  const channelIds = normalizeSignalChannelIds(broker.signal_channel_ids)

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
      aria-labelledby="broker-configurations-title"
    >
      <button
        type="button"
        className="absolute inset-0 bg-neutral-950/55"
        aria-label={modalCopy.close}
        onClick={onClose}
      />
      <div className="relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl border border-neutral-200/65 bg-white shadow-2xl dark:border-neutral-800/55 dark:bg-neutral-950 sm:max-w-2xl sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-neutral-100 px-5 py-4 dark:border-neutral-800">
          <h2 id="broker-configurations-title" className="flex min-w-0 items-center gap-2 text-base font-semibold text-neutral-900 dark:text-neutral-50">
            <PlatformLogo platform={broker.platform} />
            <span className="truncate">{broker.label}</span>
          </h2>
          <button
            type="button"
            className="rounded-lg p-2 text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
            aria-label={modalCopy.close}
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="space-y-3" aria-hidden>
              <div className="h-8 animate-pulse rounded bg-neutral-100 dark:bg-white/5" />
              <div className="h-24 animate-pulse rounded bg-neutral-100 dark:bg-white/5" />
            </div>
          ) : error ? (
            <p className="text-sm text-error-600 dark:text-error-400">{copy.loadError}</p>
          ) : channelIds.length === 0 ? (
            <p className="text-sm text-neutral-500 dark:text-neutral-400">{copy.noChannelsLinked}</p>
          ) : (
            <div className="space-y-6">
              {channelIds.map(channelId => {
                const name = channelDisplayName(channelById.get(channelId.toLowerCase()), copy.unknownChannel)
                const resolved = resolveChannelTradingConfig(broker, channelId)
                const sections = describeChannelConfiguration(
                  resolved.manual_settings,
                  modalCopy,
                  copy,
                  { accountBalance: resolveBrokerTotalBalance(broker) },
                )
                return (
                  <section key={channelId} className="space-y-3">
                    <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-neutral-900 dark:text-neutral-50">
                      <TelegramLogo />
                      <span className="truncate">{name}</span>
                    </h3>
                    <ConfigurationSections sections={sections} />
                  </section>
                )
              })}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-neutral-100 px-5 py-4 dark:border-neutral-800">
          <button
            type="button"
            className="rounded-lg px-4 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
            onClick={onClose}
          >
            {modalCopy.close}
          </button>
          {!loading && !error && channelIds.length > 0 ? (
            <button
              type="button"
              className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700"
              onClick={onEdit}
            >
              {copy.edit}
            </button>
          ) : null}
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
          <h4 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
            {section.title}
          </h4>
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

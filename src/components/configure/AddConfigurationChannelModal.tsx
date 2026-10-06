import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Plus, X } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { useSubscription } from '../../context/SubscriptionContext'
import { useT } from '../../context/LocaleContext'
import { interpolate } from '../../i18n/interpolate'
import { prepareChannelSubscriptionUpsert } from '../../lib/signalChannelRegistry'
import { upsertTelegramChannel } from '../../lib/telegramChannelApi'
import { supabase } from '../../lib/supabase'
import { Alert } from '../ui/Alert'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'

export interface ConfigurationChannelOption {
  id: string
  display_name: string
  channel_username: string
  channel_id?: string
}

function channelLabel(channel: ConfigurationChannelOption): string {
  const name = channel.display_name?.trim()
  if (name) return name
  const username = channel.channel_username?.trim()
  if (!username) return ''
  return username.startsWith('@') ? username : `@${username}`
}

export function AddConfigurationChannelModal({
  channels,
  catalog,
  emptyLabel,
  onClose,
  onCreated,
  onSelect,
}: {
  channels: ConfigurationChannelOption[]
  catalog: ConfigurationChannelOption[]
  emptyLabel: string
  onClose: () => void
  onCreated: (channel: ConfigurationChannelOption) => void
  onSelect: (channelId: string) => void
}) {
  const t = useT()
  const copy = t.configurationsPage
  const formCopy = t.channelsPage
  const { user } = useAuth()
  const { canAddChannel, limits, refresh: refreshSubscription } = useSubscription()
  const [showForm, setShowForm] = useState(false)
  const [draft, setDraft] = useState({ channel_id: '', channel_username: '', display_name: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const addChannel = async (event: React.FormEvent) => {
    event.preventDefault()
    setError('')
    if (!user?.id) return
    if (!draft.display_name.trim()) {
      setError(formCopy.nameRequired)
      return
    }
    const channelId = draft.channel_id.trim() || draft.channel_username.trim()
    const username = draft.channel_username.trim().replace(/^@/, '').toLowerCase()
    const alreadyLinked = catalog.some(channel =>
      (channelId && channel.channel_id === channelId)
      || (username && (channel.channel_username ?? '').replace(/^@/, '').toLowerCase() === username),
    )
    if (!alreadyLinked && !canAddChannel()) {
      setError(interpolate(t.pricing.paywall.channelLimit, { limit: String(limits.maxTelegramChannels ?? 5) }))
      return
    }

    setSaving(true)
    const prepared = await prepareChannelSubscriptionUpsert(supabase, {
      userId: user.id,
      telegramChatId: channelId,
      channelUsername: draft.channel_username.trim(),
      displayName: draft.display_name.trim(),
    })
    if (prepared.error) {
      setSaving(false)
      setError(prepared.error)
      return
    }
    const { channel, error: dbErr } = await upsertTelegramChannel({
      channel_id: String(prepared.row.channel_id),
      channel_username: String(prepared.row.channel_username ?? ''),
      display_name: String(prepared.row.display_name ?? ''),
      is_active: true,
    })
    setSaving(false)
    if (dbErr || !channel) {
      setError(dbErr ?? formCopy.nameRequired)
      return
    }
    onCreated({
      id: channel.id,
      display_name: channel.display_name,
      channel_username: channel.channel_username,
      channel_id: channel.channel_id,
    })
    setDraft({ channel_id: '', channel_username: '', display_name: '' })
    setShowForm(false)
    void refreshSubscription()
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-configuration-channel-title"
    >
      <button
        type="button"
        className="absolute inset-0 bg-neutral-950/55"
        aria-label={t.accountConfig.configureModal.close}
        onClick={onClose}
      />
      <div className="relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl border border-neutral-200/65 bg-white shadow-2xl dark:border-neutral-800/55 dark:bg-neutral-950 sm:max-w-lg sm:rounded-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-neutral-100 px-5 py-4 dark:border-neutral-800">
          <h2 id="add-configuration-channel-title" className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
            {copy.addChannel}
          </h2>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="rounded-lg p-2 text-teal-700 hover:bg-teal-50 dark:text-teal-300 dark:hover:bg-teal-950"
              aria-label={formCopy.addFormTitle}
              aria-expanded={showForm}
              onClick={() => {
                setError('')
                setShowForm(open => !open)
              }}
            >
              <Plus className="h-4 w-4" />
            </button>
            <button
              type="button"
              className="rounded-lg p-2 text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
              aria-label={t.accountConfig.configureModal.close}
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="overflow-y-auto px-5 py-4">
          {showForm ? (
            <form onSubmit={event => { void addChannel(event) }} className="mb-4 space-y-3">
              <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{formCopy.addFormTitle}</h3>
              {error ? <Alert>{error}</Alert> : null}
              <Input
                label={formCopy.channelName}
                placeholder={formCopy.channelNamePlaceholder}
                value={draft.display_name}
                onChange={event => setDraft(current => ({ ...current, display_name: event.target.value }))}
                required
              />
              <Input
                label={formCopy.usernameOptional}
                placeholder={formCopy.usernamePlaceholder}
                value={draft.channel_username}
                onChange={event => setDraft(current => ({ ...current, channel_username: event.target.value }))}
              />
              <Input
                label={formCopy.channelIdOptional}
                placeholder={formCopy.channelIdPlaceholder}
                value={draft.channel_id}
                onChange={event => setDraft(current => ({ ...current, channel_id: event.target.value }))}
                hint={formCopy.channelIdHint}
              />
              <div className="flex gap-2 pt-1">
                <Button type="submit" loading={saving} size="sm">{formCopy.addChannel}</Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setShowForm(false)}>
                  {t.common.cancel}
                </Button>
              </div>
            </form>
          ) : null}
          {channels.length === 0 ? (
            <p className="text-sm text-neutral-500 dark:text-neutral-400">{emptyLabel}</p>
          ) : (
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {channels.map(channel => {
                const name = channelLabel(channel) || copy.unknownChannel
                const username = channel.channel_username?.trim().replace(/^@/, '')
                return (
                  <li key={channel.id}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2.5 py-2.5 text-start hover:bg-neutral-50 dark:hover:bg-neutral-900"
                      onClick={() => onSelect(channel.id)}
                    >
                      <img src="/Telegram.svg" alt="" aria-hidden className="h-7 w-7 shrink-0 object-contain" />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-neutral-900 dark:text-neutral-50">{name}</span>
                        {username ? (
                          <span className="block truncate text-xs text-neutral-500 dark:text-neutral-400">@{username}</span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

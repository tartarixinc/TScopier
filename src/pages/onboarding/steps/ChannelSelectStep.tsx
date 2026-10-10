import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useSubscription } from '../../../context/SubscriptionContext'
import { supabase } from '../../../lib/supabase'
import { Card } from '../../../components/ui/Card'
import { Button } from '../../../components/ui/Button'
import { Badge } from '../../../components/ui/Badge'
import { Alert } from '../../../components/ui/Alert'
import { prepareChannelSubscriptionUpsert } from '../../../lib/signalChannelRegistry'
import { upsertTelegramChannels } from '../../../lib/telegramChannelApi'
import { callTelegramAuth } from '../../../lib/telegramAuthApi'
import { interpolate } from '../../../i18n/interpolate'
import { useT } from '../../../context/LocaleContext'
import { Radio, Check } from 'lucide-react'

interface TgChannel {
  id: string
  title: string
  username: string
  members_count: number
}

interface Props {
  sessionId: string | null
  onDone: () => void
}

const EDGE_FN = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/telegram-auth`

export function ChannelSelectStep({ onDone }: Props) {
  const t = useT()
  const pw = t.pricing.paywall
  const { session } = useAuth()
  const { canAddChannel, limits, usage, refresh: refreshSubscription } = useSubscription()
  const [channels, setChannels] = useState<TgChannel[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const channelCap = limits.maxTelegramChannels
  const remainingSlots = channelCap == null
    ? null
    : Math.max(0, channelCap - usage.telegramChannels)

  useEffect(() => {
    const fetchChannels = async () => {
      setLoading(true)
      try {
        const { ok, data } = await callTelegramAuth<{ channels?: TgChannel[] }>(
          EDGE_FN,
          session?.access_token,
          'list_channels',
          {},
        )
        if (!ok || data.error) {
          setError(data.error || 'Failed to load channels')
          return
        }
        setChannels(data.channels || [])
      } catch {
        setError('Failed to fetch your Telegram channels')
      } finally {
        setLoading(false)
      }
    }

    fetchChannels()
  }, [session])

  const toggleChannel = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
        return next
      }
      if (remainingSlots != null && next.size >= remainingSlots) {
        setError(interpolate(pw.channelLimit, { limit: String(channelCap ?? 5) }))
        return prev
      }
      next.add(id)
      return next
    })
  }

  const handleSave = async () => {
    if (selected.size === 0) {
      onDone()
      return
    }
    if (remainingSlots != null && selected.size > remainingSlots) {
      setError(interpolate(pw.channelLimit, { limit: String(channelCap ?? 5) }))
      return
    }
    if (!canAddChannel() && selected.size > 0) {
      setError(interpolate(pw.channelLimit, { limit: String(channelCap ?? 5) }))
      return
    }

    setSaving(true)
    setError('')
    const userId = (await supabase.auth.getUser()).data.user!.id

    const rows: Array<{
      channel_id: string
      channel_username: string
      display_name: string
      is_active: boolean
    }> = []
    for (const c of channels.filter(ch => selected.has(ch.id))) {
      const prepared = await prepareChannelSubscriptionUpsert(supabase, {
        userId,
        telegramChatId: c.id,
        channelUsername: c.username || '',
        displayName: c.title,
      })
      if (prepared.error) {
        setSaving(false)
        setError(prepared.error)
        return
      }
      rows.push({
        channel_id: String(prepared.row.channel_id),
        channel_username: String(prepared.row.channel_username ?? ''),
        display_name: String(prepared.row.display_name ?? ''),
        is_active: true,
      })
    }

    const { error: dbErr } = await upsertTelegramChannels(rows)

    setSaving(false)

    if (dbErr) {
      setError(dbErr)
      return
    }

    void refreshSubscription()
    onDone()
  }

  return (
    <Card>
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">Select signal channels</h2>
        <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
          Choose which Telegram channels to monitor for trade signals. You can change this later.
        </p>
      </div>

      {error && <Alert className="mb-4 py-2.5">{error}</Alert>}

      {loading ? (
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-14 bg-neutral-100 dark:bg-neutral-800 rounded-lg animate-pulse" />
          ))}
        </div>
      ) : channels.length === 0 ? (
        <div className="text-center py-8 text-neutral-400">
          <Radio className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm">No channels found in your Telegram account.</p>
          <p className="text-xs mt-1">Join a signal channel in Telegram first, then come back.</p>
        </div>
      ) : (
        <div className="space-y-1.5 max-h-64 overflow-y-auto mb-4">
          {channels.map(channel => {
            const isSelected = selected.has(channel.id)
            return (
              <button
                key={channel.id}
                type="button"
                onClick={() => toggleChannel(channel.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-colors ${
                  isSelected
                    ? 'border-primary-200 bg-primary-50'
                    : 'border-neutral-200/65 dark:border-neutral-800/55 hover:border-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800/50'
                }`}
              >
                <div className={`w-5 h-5 rounded flex items-center justify-center flex-shrink-0 border transition-colors ${
                  isSelected ? 'bg-teal-600 border-teal-600' : 'border-neutral-300'
                }`}>
                  {isSelected && <Check className="w-3 h-3 text-white" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50 truncate">{channel.title}</p>
                  {channel.username && (
                    <p className="text-xs text-neutral-400">@{channel.username}</p>
                  )}
                </div>
                {channel.members_count > 0 && (
                  <Badge variant="neutral" size="sm">
                    {channel.members_count.toLocaleString()}
                  </Badge>
                )}
              </button>
            )
          })}
        </div>
      )}

      <div className="flex items-center justify-between pt-2">
        <span className="text-sm text-neutral-500 dark:text-neutral-400">
          {selected.size > 0 ? `${selected.size} selected` : 'Select channels to monitor'}
        </span>
        <Button
          onClick={handleSave}
          loading={saving}
          disabled={loading}
          size="lg"
        >
          {selected.size === 0 ? 'Skip for now' : 'Start monitoring'}
        </Button>
      </div>
    </Card>
  )
}

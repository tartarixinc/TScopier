import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../lib/supabase'
import { Card } from '../../../components/ui/Card'
import { Button } from '../../../components/ui/Button'
import { Alert } from '../../../components/ui/Alert'
import { prepareChannelSubscriptionUpsert } from '../../../lib/signalChannelRegistry'
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
  const { session } = useAuth()
  const [channels, setChannels] = useState<TgChannel[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const fetchChannels = async () => {
      setLoading(true)
      try {
        const res = await fetch(EDGE_FN, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${session?.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ action: 'list_channels' }),
        })
        const data = await res.json()
        if (!res.ok || data.error) {
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
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleSave = async () => {
    if (selected.size === 0) {
      onDone()
      return
    }

    setSaving(true)
    const userId = (await supabase.auth.getUser()).data.user!.id

    const rows: Record<string, unknown>[] = []
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
      rows.push(prepared.row)
    }

    const { error: dbErr } = await supabase
      .from('telegram_channels')
      .upsert(rows, { onConflict: 'user_id,channel_id' })

    setSaving(false)

    if (dbErr) {
      setError(dbErr.message)
      return
    }

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
                    : 'border-neutral-200 dark:border-neutral-800 hover:border-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800/50'
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

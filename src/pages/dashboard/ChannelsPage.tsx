import { useEffect, useState } from 'react'
import { Plus, Radio, Trash2, Settings } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../context/AuthContext'
import { useT } from '../../context/LocaleContext'
import { Card } from '../../components/ui/Card'
import { Badge } from '../../components/ui/Badge'
import { Toggle } from '../../components/ui/Toggle'
import { Button } from '../../components/ui/Button'
import { Alert } from '../../components/ui/Alert'
import { Input } from '../../components/ui/Input'
import type { TelegramChannel } from '../../types/database'

export function ChannelsPage() {
  const t = useT()
  const ch = t.channelsPage
  const { user } = useAuth()
  const [channels, setChannels] = useState<TelegramChannel[]>([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [newChannel, setNewChannel] = useState({ channel_id: '', channel_username: '', display_name: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!user) return
    loadChannels()
  }, [user])

  const loadChannels = async () => {
    const { data } = await supabase
      .from('telegram_channels')
      .select('*')
      .eq('user_id', user!.id)
      .order('created_at', { ascending: false })
    setChannels(data ?? [])
    setLoading(false)
  }

  const toggleChannel = async (id: string, is_active: boolean) => {
    setChannels(prev => prev.map(c => c.id === id ? { ...c, is_active } : c))
    await supabase.from('telegram_channels').update({ is_active }).eq('id', id)
  }

  const deleteChannel = async (id: string) => {
    setChannels(prev => prev.filter(c => c.id !== id))
    await supabase.from('telegram_channels').delete().eq('id', id)
  }

  const addChannel = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (!newChannel.display_name.trim()) {
      setError(ch.nameRequired)
      return
    }

    setSaving(true)
    const { data, error: dbErr } = await supabase
      .from('telegram_channels')
      .insert({
        user_id: user!.id,
        channel_id: newChannel.channel_id.trim() || newChannel.channel_username.trim(),
        channel_username: newChannel.channel_username.trim().replace(/^@/, ''),
        display_name: newChannel.display_name.trim(),
        is_active: true,
      })
      .select('*')
      .single()

    setSaving(false)

    if (dbErr) {
      setError(dbErr.message)
      return
    }

    setChannels(prev => [data, ...prev])
    setNewChannel({ channel_id: '', channel_username: '', display_name: '' })
    setShowAdd(false)
  }

  const updateSettings = async (id: string, updates: Partial<TelegramChannel>) => {
    await supabase.from('telegram_channels').update(updates).eq('id', id)
    setChannels(prev => prev.map(c => c.id === id ? { ...c, ...updates } : c))
    setEditingId(null)
  }

  return (
    <div className="p-6 lg:p-8 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-900 dark:text-neutral-50">{ch.title}</h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-0.5">{ch.subtitle}</p>
        </div>
        <Button onClick={() => setShowAdd(true)} size="sm">
          <Plus className="w-3.5 h-3.5" />
          {ch.addChannel}
        </Button>
      </div>

      {showAdd && (
        <Card className="mb-4">
          <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50 mb-4">{ch.addFormTitle}</h2>
          {error && <Alert className="mb-3">{error}</Alert>}
          <form onSubmit={addChannel} className="space-y-3">
            <Input
              label={ch.channelName}
              placeholder={ch.channelNamePlaceholder}
              value={newChannel.display_name}
              onChange={e => setNewChannel(p => ({ ...p, display_name: e.target.value }))}
              required
            />
            <Input
              label={ch.usernameOptional}
              placeholder={ch.usernamePlaceholder}
              value={newChannel.channel_username}
              onChange={e => setNewChannel(p => ({ ...p, channel_username: e.target.value }))}
            />
            <Input
              label={ch.channelIdOptional}
              placeholder={ch.channelIdPlaceholder}
              value={newChannel.channel_id}
              onChange={e => setNewChannel(p => ({ ...p, channel_id: e.target.value }))}
              hint={ch.channelIdHint}
            />
            <div className="flex gap-2 pt-1">
              <Button type="submit" loading={saving} size="sm">{ch.addChannel}</Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setShowAdd(false)}>
                {t.common.cancel}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {loading ? (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-16 bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 animate-pulse" />
          ))}
        </div>
      ) : channels.length === 0 ? (
        <Card>
          <div className="text-center py-8">
            <Radio className="w-10 h-10 mx-auto mb-3 text-neutral-200" />
            <p className="text-neutral-500 dark:text-neutral-400 text-sm font-medium">{ch.emptyTitle}</p>
            <p className="text-neutral-400 text-xs mt-1">{ch.emptySubtitle}</p>
          </div>
        </Card>
      ) : (
        <div className="space-y-2">
          {channels.map(channel => (
            <ChannelCard
              key={channel.id}
              channel={channel}
              isEditing={editingId === channel.id}
              onToggle={is_active => toggleChannel(channel.id, is_active)}
              onDelete={() => deleteChannel(channel.id)}
              onEditToggle={() => setEditingId(editingId === channel.id ? null : channel.id)}
              onSave={updates => updateSettings(channel.id, updates)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ChannelCard({
  channel,
  isEditing,
  onToggle,
  onDelete,
  onEditToggle,
  onSave,
}: {
  channel: TelegramChannel
  isEditing: boolean
  onToggle: (v: boolean) => void
  onDelete: () => void
  onEditToggle: () => void
  onSave: (updates: Partial<TelegramChannel>) => void
}) {
  const t = useT()
  const ch = t.channelsPage
  const [lotSize, setLotSize] = useState(channel.lot_size_override?.toString() ?? '')
  const [pipTolerance, setPipTolerance] = useState(channel.pip_tolerance_override?.toString() ?? '')

  return (
    <Card padding="none">
      <div className="px-4 py-3.5 flex items-center gap-3">
        <div className="w-9 h-9 bg-primary-50 rounded-lg flex items-center justify-center flex-shrink-0">
          <Radio className="w-4 h-4 text-primary-600" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50 truncate">{channel.display_name}</p>
            {!channel.is_active && <Badge variant="neutral" size="sm">{ch.statusPaused}</Badge>}
          </div>
          {channel.channel_username && (
            <p className="text-xs text-neutral-400">@{channel.channel_username}</p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Toggle checked={channel.is_active} onChange={onToggle} />
          <button
            type="button"
            onClick={onEditToggle}
            className="p-1.5 rounded-lg text-neutral-400 hover:text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:bg-neutral-800 transition-colors"
          >
            <Settings className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="p-1.5 rounded-lg text-neutral-400 hover:text-error-600 hover:bg-error-50 transition-colors"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {isEditing && (
        <div className="px-4 pb-4 border-t border-neutral-100 dark:border-neutral-800 pt-3">
          <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-3">{ch.overridesTitle}</p>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label={ch.lotSizeOverride}
              type="number"
              min="0.01"
              step="0.01"
              placeholder={ch.useBrokerDefault}
              value={lotSize}
              onChange={e => setLotSize(e.target.value)}
            />
            <Input
              label={ch.pipToleranceOverride}
              type="number"
              min="1"
              placeholder={ch.useBrokerDefault}
              value={pipTolerance}
              onChange={e => setPipTolerance(e.target.value)}
            />
          </div>
          <div className="flex gap-2 mt-3">
            <Button
              size="sm"
              onClick={() => onSave({
                lot_size_override: lotSize ? parseFloat(lotSize) : null,
                pip_tolerance_override: pipTolerance ? parseInt(pipTolerance) : null,
              })}
            >
              {t.common.save}
            </Button>
            <Button size="sm" variant="ghost" onClick={onEditToggle}>
              {t.common.cancel}
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}

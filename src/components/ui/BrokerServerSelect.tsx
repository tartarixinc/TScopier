import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { ChevronDown, Server } from 'lucide-react'
import { useT } from '../../context/LocaleContext'
import { interpolate } from '../../i18n/interpolate'
import {
  loadBrokerServers,
  filterBrokerGroups,
  type BrokerServerGroup,
} from '../../lib/brokerServers'

interface BrokerServerSelectProps {
  platform: 'MT4' | 'MT5'
  value: string
  onChange: (value: string) => void
  label?: string
  hint?: string
  required?: boolean
}

/**
 * Typeahead for MT server names backed by the `mt_servers` table.
 * Servers are loaded once per platform, grouped by broker, and filtered locally.
 * Free-text entry is always allowed: unknown servers fall through to onChange.
 */
export function BrokerServerSelect({
  platform,
  value,
  onChange,
  label,
  hint,
  required,
}: BrokerServerSelectProps) {
  const t = useT()
  const cf = t.accountConfig.connectForm
  const resolvedLabel = label ?? cf.brokerServerLabel
  const [groups, setGroups] = useState<BrokerServerGroup[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    loadBrokerServers(platform)
      .then(data => { if (!cancelled) setGroups(data) })
      .catch(() => { if (!cancelled) setGroups([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [platform])

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!containerRef.current) return
      if (!containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const visibleGroups = useMemo(() => filterBrokerGroups(groups, value), [groups, value])
  const totalServers = useMemo(() => groups.reduce((n, g) => n + g.servers.length, 0), [groups])

  return (
    <div className="flex flex-col gap-1.5" ref={containerRef}>
      {resolvedLabel && (
        <label className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
          {resolvedLabel}
          {required && <span className="text-error-500"> *</span>}
        </label>
      )}
      <div className="relative">
        <input
          type="text"
          value={value}
          required={required}
          onChange={e => { onChange(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          placeholder={
            loading
              ? cf.brokerServerLoading
              : interpolate(cf.brokerServerSearch, { count: String(totalServers), platform })
          }
          className="w-full px-3 py-2 pr-9 text-sm rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-50 placeholder:text-neutral-400 hover:border-neutral-300 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setOpen(o => !o)}
          className="absolute inset-y-0 right-0 flex items-center px-2 text-neutral-400 hover:text-neutral-600 dark:text-neutral-400"
        >
          <ChevronDown className={clsx('w-4 h-4 transition-transform', open && 'rotate-180')} />
        </button>

        {open && (
          <div className="absolute z-30 mt-1 w-full max-h-72 overflow-y-auto rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-lg">
            {loading ? (
              <div className="px-3 py-2 text-sm text-neutral-500 dark:text-neutral-400">{t.common.loading}</div>
            ) : visibleGroups.length === 0 ? (
              <div className="px-3 py-2 text-sm text-neutral-500 dark:text-neutral-400">
                {interpolate(cf.brokerServerNoMatch, { server: value || '—' })}
              </div>
            ) : (
              visibleGroups.map(group => (
                <div key={group.broker_label} className="py-1">
                  <div className="px-3 pt-1.5 pb-0.5 text-[11px] uppercase tracking-wide text-neutral-400 font-medium flex items-center gap-1.5">
                    <Server className="w-3 h-3" />
                    {group.broker_label}
                  </div>
                  {group.servers.slice(0, 50).map(server => (
                    <button
                      key={server.id}
                      type="button"
                      onMouseDown={() => {
                        onChange(server.server_name)
                        setOpen(false)
                      }}
                      className={clsx(
                        'w-full text-left px-3 py-1.5 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800/50',
                        server.server_name === value && 'bg-primary-50 text-primary-700',
                      )}
                    >
                      {server.server_name}
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        )}
      </div>
      {hint && <p className="text-xs text-neutral-500 dark:text-neutral-400">{hint}</p>}
    </div>
  )
}

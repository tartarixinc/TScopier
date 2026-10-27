import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronUp, OctagonAlert, Pause, Play, Plus, Settings, Square, Trash2, X } from 'lucide-react'
import clsx from 'clsx'
import { SlaveConfigureModal } from '../../components/configure/SlaveConfigureModal'
import { SlaveChannelConflictModal } from '../../components/dashboard/SlaveChannelConflictModal'
import { useAuth } from '../../context/AuthContext'
import { useAddTradingAccount } from '../../context/AddTradingAccountContext'
import { useBrokerAccounts } from '../../context/BrokerAccountsContext'
import { useT } from '../../context/LocaleContext'
import { disconnectChannelFromBroker, getBrokerDisplayLabel, normalizeSignalChannelIds } from '../../lib/brokerChannelLink'
import {
  connectBrokerCopyLink,
  disconnectBrokerCopyLinkSafely,
  fetchBrokerCopyLinks,
  fetchMirrorCopyLinkStates,
  humanizeMirrorDeleteError,
  mirrorCopyStatusTone,
  setBrokerCopySource,
  setMirrorCopyLinkStatus,
  updateBrokerCopyLinkSettings,
  type BrokerCopyLinkRow,
  type MirrorCopyDesiredStatus,
  type MirrorCopyLinkStateRow,
} from '../../lib/brokerCopyLink'
import type { CopyRiskTranslations } from '../../i18n/locales/copyRiskLabels'
import { interpolate } from '../../i18n/interpolate'
import { supabase } from '../../lib/supabase'
import { platformIconSrc } from '../../lib/activityRoute'
import { copyRiskForEditor, manualSettingsFromCopyRisk, mirrorSizingValue, normalizeCopyRisk } from '../../lib/copyRiskTypes'
import type { BrokerAccount, ManualSettings } from '../../types/database'
import { PageHeader } from '../../components/layout/PageHeader'
import { PageShell } from '../../components/layout/PageShell'
import { Alert } from '../../components/ui/Alert'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { Card } from '../../components/ui/Card'
import { Toggle } from '../../components/ui/Toggle'

const DISMISSED_DESTINATION_KEY = 'tscopier:configurations:dismissed-destinations:'
const SLAVE_KEY = 'tscopier:mirror-trading:slaves:'
const REMOVE_SLAVE_CONFIRM_FALLBACK =
  'Remove this slave account? Any copied trades still open on it will be closed first.'
const STOP_COPYING_CONFIRM_FALLBACK =
  'Stop copying and close all copied trades on this slave account? Copying stays off until you start it again.'

function readIds(key: string): string[] {
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

function writeIds(key: string, ids: string[]) {
  try {
    if (ids.length === 0) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(ids))
  } catch {
    // A full quota should not block the account change itself.
  }
}

function mirrorPlatformIconSrc(platform: string): string {
  return platformIconSrc(platform) ?? '/MT5.png'
}

function AccountMark({ platform, size = 'md' }: { platform: string; size?: 'sm' | 'md' }) {
  const [failed, setFailed] = useState(false)
  if (failed) return null
  return (
    <img
      src={mirrorPlatformIconSrc(platform)}
      alt=""
      aria-hidden
      className={size === 'sm' ? 'h-6 w-6 shrink-0 object-contain' : 'h-8 w-8 shrink-0 object-contain'}
      onError={() => setFailed(true)}
    />
  )
}

function AccountChooser({
  title,
  brokers,
  emptyLabel,
  connectLabel,
  closeLabel,
  loginLabel,
  onClose,
  onSelect,
  onConnectNew,
}: {
  title: string
  brokers: BrokerAccount[]
  emptyLabel: string
  connectLabel: string
  closeLabel: string
  loginLabel: string
  onClose: () => void
  onSelect: (brokerId: string) => void
  onConnectNew: () => void
}) {
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
      aria-labelledby="mirror-account-chooser-title"
    >
      <button type="button" className="absolute inset-0 bg-neutral-950/55" aria-label={closeLabel} onClick={onClose} />
      <div className="relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl border border-neutral-200/65 bg-white shadow-2xl dark:border-neutral-800/55 dark:bg-neutral-950 sm:max-w-lg sm:rounded-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-neutral-100 px-5 py-4 dark:border-neutral-800">
          <h2 id="mirror-account-chooser-title" className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
            {title}
          </h2>
          <button
            type="button"
            className="rounded-lg p-2 text-neutral-900 hover:bg-neutral-100 dark:text-neutral-50 dark:hover:bg-neutral-800"
            aria-label={closeLabel}
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">
          {brokers.length === 0 ? (
            <p className="text-sm text-neutral-900 dark:text-neutral-50">{emptyLabel}</p>
          ) : (
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {brokers.map(broker => (
                <li key={broker.id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2.5 py-2.5 text-start hover:bg-neutral-50 dark:hover:bg-neutral-900"
                    onClick={() => onSelect(broker.id)}
                  >
                    <AccountMark platform={broker.platform} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-neutral-900 dark:text-neutral-50">
                        {getBrokerDisplayLabel(broker)}
                      </span>
                      {broker.account_login?.trim() ? (
                        <span className="block truncate text-xs text-neutral-900 dark:text-neutral-50">
                          {loginLabel} {broker.account_login.trim()}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Button type="button" className="mt-4 w-full" onClick={onConnectNew}>
            {connectLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function MirrorTradingPage() {
  const t = useT()
  const copy = t.mirrorTradingPage
  const { user } = useAuth()
  const { brokers, replaceBroker, toggleBrokerActive } = useBrokerAccounts()
  const {
    openAddTradingAccount,
    pendingSourceBroker,
    clearPendingSourceBroker,
    pendingDestinationBrokers,
    clearPendingDestinationBrokers,
  } = useAddTradingAccount()
  const [links, setLinks] = useState<BrokerCopyLinkRow[]>([])
  const [slaveIds, setSlaveIds] = useState<string[]>([])
  const [slaveUserId, setSlaveUserId] = useState<string | null>(null)
  const [chooser, setChooser] = useState<'master' | 'slave' | null>(null)
  const [slaveForMasterId, setSlaveForMasterId] = useState<string | null>(null)
  const [collapsedMasterIds, setCollapsedMasterIds] = useState<string[]>([])
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [error, setError] = useState<string | null>(null)
  const [configuringSlaveId, setConfiguringSlaveId] = useState<string | null>(null)
  const [configSaveError, setConfigSaveError] = useState<string | null>(null)
  const [linkStates, setLinkStates] = useState<Record<string, MirrorCopyLinkStateRow>>({})
  const [busyLinkId, setBusyLinkId] = useState<string | null>(null)
  const [removingSlaveId, setRemovingSlaveId] = useState<string | null>(null)
  const [channelConflict, setChannelConflict] = useState<{
    brokerId: string
    masterId: string | null
    channels: { id: string; name: string }[]
  } | null>(null)
  const [channelConflictBusy, setChannelConflictBusy] = useState(false)
  const [channelConflictError, setChannelConflictError] = useState<string | null>(null)
  const assignAfterConnectRef = useRef<string | null>(null)
  const chainRef = useRef(Promise.resolve())
  const settingsSaveRef = useRef(Promise.resolve())
  const brokersRef = useRef(brokers)
  const linksRef = useRef(links)
  brokersRef.current = brokers
  linksRef.current = links

  useEffect(() => {
    if (!user?.id) {
      setLinks([])
      setSlaveIds([])
      setSlaveUserId(null)
      return
    }
    setSlaveIds(readIds(`${SLAVE_KEY}${user.id}`))
    setSlaveUserId(user.id)
    let cancelled = false
    void fetchBrokerCopyLinks(supabase, user.id).then(result => {
      if (cancelled) return
      if (result.error) setError(result.error)
      else setLinks(result.links)
    })
    return () => {
      cancelled = true
    }
  }, [user?.id])

  useEffect(() => {
    if (!user?.id || slaveUserId !== user.id) return
    writeIds(`${SLAVE_KEY}${user.id}`, slaveIds)
  }, [slaveIds, slaveUserId, user?.id])

  // Link lifecycle state is worker-owned. Poll it while the page is open so the
  // status badge follows activation and any error the worker records.
  useEffect(() => {
    if (!user?.id || links.length === 0) return
    let cancelled = false
    const load = () => {
      void fetchMirrorCopyLinkStates(supabase, links.map(link => link.id)).then(result => {
        if (cancelled) return
        if (!result.error) setLinkStates(result.states)
      })
    }
    load()
    const timer = setInterval(load, 10_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [user?.id, links])

  const changeCopying = useCallback((link: BrokerCopyLinkRow, status: MirrorCopyDesiredStatus) => {
    if (!user?.id || busyLinkId) return
    setBusyLinkId(link.id)
    setError(null)
    void setMirrorCopyLinkStatus(supabase, link.id, status).then(result => {
      if (result.error) {
        setError(result.error)
        setBusyLinkId(null)
        return
      }
      void fetchMirrorCopyLinkStates(supabase, [link.id]).then(refreshed => {
        if (!refreshed.error) setLinkStates(prev => ({ ...prev, ...refreshed.states }))
        setBusyLinkId(null)
      })
    })
  }, [user?.id, busyLinkId])

  // Link removals can be refused by the database while copied trades are still
  // open; the refusal text carries a marker the user should never see.
  const fail = useCallback((message: string | null) => {
    setError(humanizeMirrorDeleteError(message))
  }, [])

  const dismissDestination = useCallback((brokerId: string) => {
    if (!user?.id) return
    const key = `${DISMISSED_DESTINATION_KEY}${user.id}`
    const current = readIds(key)
    if (!current.includes(brokerId)) writeIds(key, [...current, brokerId])
  }, [user?.id])

  const undismissDestination = useCallback((brokerId: string) => {
    if (!user?.id) return
    const key = `${DISMISSED_DESTINATION_KEY}${user.id}`
    writeIds(key, readIds(key).filter(id => id !== brokerId))
  }, [user?.id])

  const enqueue = useCallback((task: () => Promise<void>) => {
    const next = chainRef.current.then(task, task)
    chainRef.current = next.then(() => undefined, () => undefined)
  }, [])

  const promoteMaster = useCallback((brokerId: string) => {
    enqueue(async () => {
      if (!user?.id) return
      setError(null)
      const { broker, error: saveError } = await setBrokerCopySource(supabase, user.id, brokerId, true)
      if (saveError || !broker) {
        fail(saveError ?? copy.loadError)
        return
      }
      replaceBroker(broker)
      setLinks(prev => prev.filter(link => link.destination_broker_account_id !== brokerId))
      setSlaveIds(prev => prev.filter(id => id !== brokerId))
    })
  }, [copy.loadError, enqueue, fail, replaceBroker, user?.id])

  const addSlave = useCallback((brokerId: string) => {
    enqueue(async () => {
      if (!user?.id) return
      setError(null)
      const current = brokersRef.current.find(broker => broker.id === brokerId)
      if (current?.copy_source === true) {
        const { broker, error: saveError } = await setBrokerCopySource(supabase, user.id, brokerId, false)
        if (saveError || !broker) {
          fail(saveError ?? copy.loadError)
          return
        }
        replaceBroker(broker)
        setLinks(prev => prev.filter(link => link.source_broker_account_id !== brokerId))
      }
      undismissDestination(brokerId)
      setSlaveIds(prev => (prev.includes(brokerId) ? prev : [...prev, brokerId]))
    })
  }, [copy.loadError, enqueue, fail, replaceBroker, undismissDestination, user?.id])

  const removeMaster = useCallback((brokerId: string) => {
    enqueue(async () => {
      if (!user?.id) return
      setError(null)
      const { broker, error: saveError } = await setBrokerCopySource(supabase, user.id, brokerId, false)
      if (saveError || !broker) {
        fail(saveError ?? copy.loadError)
        return
      }
      replaceBroker(broker)
      setLinks(prev => prev.filter(link => link.source_broker_account_id !== brokerId))
      dismissDestination(brokerId)
    })
  }, [copy.loadError, dismissDestination, enqueue, fail, replaceBroker, user?.id])

  // Removing a slave (or moving it to another master) now flattens first when
  // copied trades are still open: the helper asks the worker to stop the link,
  // waits for the confirmation, and only then deletes. On a failed stop the link
  // stays, so nothing is left unmanaged at the broker.
  const removeSlave = useCallback((brokerId: string) => {
    if (!window.confirm(copy.removeSlaveConfirm ?? REMOVE_SLAVE_CONFIRM_FALLBACK)) return
    enqueue(async () => {
      if (!user?.id) return
      setError(null)
      setRemovingSlaveId(brokerId)
      try {
        const existing = linksRef.current.filter(link => link.destination_broker_account_id === brokerId)
        for (const link of existing) {
          setBusyLinkId(link.id)
          try {
            const result = await disconnectBrokerCopyLinkSafely(supabase, user.id, link)
            if (result.error) {
              fail(result.error)
              return
            }
          } finally {
            setBusyLinkId(null)
          }
        }
        setLinks(prev => prev.filter(link => link.destination_broker_account_id !== brokerId))
        setSlaveIds(prev => prev.filter(id => id !== brokerId))
      } finally {
        setRemovingSlaveId(null)
      }
    })
  }, [copy.removeSlaveConfirm, enqueue, fail, user?.id])

  const assignMaster = useCallback((slaveId: string, masterId: string) => {
    enqueue(async () => {
      if (!user?.id) return
      setError(null)
      setRemovingSlaveId(slaveId)
      try {
        const existing = linksRef.current.filter(link => link.destination_broker_account_id === slaveId)
        for (const link of existing) {
          if (link.source_broker_account_id === masterId) continue
          setBusyLinkId(link.id)
          try {
            const result = await disconnectBrokerCopyLinkSafely(supabase, user.id, link)
            if (result.error) {
              fail(result.error)
              return
            }
          } finally {
            setBusyLinkId(null)
          }
        }
        setLinks(prev => prev.filter(link =>
          link.destination_broker_account_id !== slaveId || link.source_broker_account_id === masterId,
        ))
        if (!masterId || existing.some(link => link.source_broker_account_id === masterId)) return
        const { link, error: saveError } = await connectBrokerCopyLink(supabase, user.id, masterId, slaveId)
        if (saveError || !link) {
          fail(saveError ?? copy.loadError)
          return
        }
        undismissDestination(slaveId)
        setLinks(prev => (prev.some(item => item.id === link.id) ? prev : [...prev, link]))
      } finally {
        setRemovingSlaveId(null)
      }
    })
  }, [copy.loadError, enqueue, fail, undismissDestination, user?.id])

  // Slave accounts linked to owned Telegram channels are blocked until the
  // user disconnects them, so the same signal cannot trade twice on one broker.
  const currentUserId = user?.id ?? null
  const selectSlaveAccount = useCallback((brokerId: string, masterId: string | null) => {
    const proceed = () => {
      addSlave(brokerId)
      if (masterId) assignMaster(brokerId, masterId)
    }
    if (!currentUserId) {
      proceed()
      return
    }
    const broker = brokersRef.current.find(item => item.id === brokerId)
    const channelIds = normalizeSignalChannelIds(broker?.signal_channel_ids)
    if (channelIds.length === 0) {
      proceed()
      return
    }
    setChannelConflictError(null)
    void (async () => {
      let channels: { id: string; name: string }[]
      try {
        const { data, error } = await supabase
          .from('telegram_channels')
          .select('id,display_name,channel_username')
          .eq('user_id', currentUserId)
          .in('id', channelIds)
        if (error) throw error
        const byId = new Map((data ?? []).map(row => [row.id as string, row as { display_name: string | null; channel_username: string | null }]))
        channels = channelIds.map(id => {
          const row = byId.get(id)
          return {
            id,
            name: row?.display_name?.trim() || row?.channel_username?.trim() || id,
          }
        })
      } catch {
        // A rejected read must not leave the user with a silent no-op after
        // the chooser closed; open the modal with the raw channel ids.
        channels = channelIds.map(id => ({ id, name: id }))
      }
      setChannelConflict({ brokerId, masterId, channels })
    })()
  }, [addSlave, assignMaster, currentUserId])

  const disconnectChannelsAndContinue = useCallback(async () => {
    if (!currentUserId || !channelConflict || channelConflictBusy) return
    setChannelConflictBusy(true)
    setChannelConflictError(null)
    try {
      const broker = brokersRef.current.find(item => item.id === channelConflict.brokerId)
      if (!broker) {
        setChannelConflict(null)
        return
      }
      let updated: BrokerAccount | null = broker
      for (const channel of channelConflict.channels) {
        const result = await disconnectChannelFromBroker(supabase, currentUserId, updated, channel.id)
        if (result.error || !result.broker) {
          // Keep the channels already removed in this loop visible as removed.
          if (updated !== broker) replaceBroker(updated)
          setChannelConflictError(result.error ?? copy.loadError)
          return
        }
        updated = result.broker
      }
      replaceBroker(updated)
      const { brokerId, masterId } = channelConflict
      setChannelConflict(null)
      addSlave(brokerId)
      if (masterId) assignMaster(brokerId, masterId)
    } finally {
      setChannelConflictBusy(false)
    }
  }, [addSlave, assignMaster, channelConflict, channelConflictBusy, copy.loadError, currentUserId, replaceBroker])

  useEffect(() => {
    if (!pendingSourceBroker || !user?.id) return
    const brokerId = pendingSourceBroker.id
    clearPendingSourceBroker()
    promoteMaster(brokerId)
  }, [clearPendingSourceBroker, pendingSourceBroker, promoteMaster, user?.id])

  useEffect(() => {
    if (pendingDestinationBrokers.length === 0 || !user?.id) return
    const ids = pendingDestinationBrokers.map(broker => broker.id)
    const masterId = assignAfterConnectRef.current
    assignAfterConnectRef.current = null
    clearPendingDestinationBrokers()
    // Route through the channel-conflict check: a reconnected pre-existing
    // account can already own channel links.
    for (const id of ids) {
      selectSlaveAccount(id, masterId)
    }
  }, [clearPendingDestinationBrokers, pendingDestinationBrokers, selectSlaveAccount, user?.id])

  const patchSlaveSettings = useCallback((slaveId: string, patch: Partial<ManualSettings>) => {
    const task = settingsSaveRef.current.then(async () => {
      if (!user?.id) return
      const current = linksRef.current.find(link => link.destination_broker_account_id === slaveId)
      if (!current) return
      const nextSettings = { ...current.manual_settings, ...patch }
      const previous = linksRef.current
      const nextLinks = previous.map(link => (
        link.id === current.id ? { ...link, manual_settings: nextSettings } : link
      ))
      linksRef.current = nextLinks
      setLinks(nextLinks)
      setConfigSaveError(null)
      const { error: saveError } = await updateBrokerCopyLinkSettings(supabase, user.id, current.id, nextSettings)
      if (!saveError) return
      linksRef.current = previous
      setLinks(previous)
      setConfigSaveError(saveError)
    })
    settingsSaveRef.current = task.then(() => undefined, () => undefined)
  }, [user?.id])

  const setSlaveEmergency = useCallback((slaveId: string, enabled: boolean) => {
    const current = linksRef.current.find(link => link.destination_broker_account_id === slaveId)
    if (!current) return
    const profile = copyRiskForEditor(current.manual_settings)
    profile.protection.emergency_stop = enabled
    profile.lifecycle.pause_new = enabled
    patchSlaveSettings(slaveId, manualSettingsFromCopyRisk(profile))
  }, [patchSlaveSettings])

  const masters = useMemo(
    () => brokers.filter(broker => broker.copy_source === true),
    [brokers],
  )
  const masterIds = useMemo(() => new Set(masters.map(broker => broker.id)), [masters])
  const slaves = useMemo(() => {
    const ids = new Set(slaveIds)
    for (const link of links) {
      if (!masterIds.has(link.destination_broker_account_id)) ids.add(link.destination_broker_account_id)
    }
    return brokers.filter(broker => broker.copy_source !== true && ids.has(broker.id))
  }, [brokers, links, masterIds, slaveIds])
  const slaveIdSet = useMemo(() => new Set(slaves.map(broker => broker.id)), [slaves])
  const availableAccounts = useMemo(
    () => brokers.filter(broker => broker.copy_source !== true && !slaveIdSet.has(broker.id)),
    [brokers, slaveIdSet],
  )

  const closeLabel = t.accountConfig.configureModal.close
  const groups = useMemo(() => {
    const byMaster = new Map<string, BrokerAccount[]>()
    const unassigned: BrokerAccount[] = []
    for (const slave of slaves) {
      const masterId = links.find(link =>
        link.destination_broker_account_id === slave.id && masterIds.has(link.source_broker_account_id),
      )?.source_broker_account_id
      if (!masterId) {
        unassigned.push(slave)
        continue
      }
      const list = byMaster.get(masterId) ?? []
      list.push(slave)
      byMaster.set(masterId, list)
    }
    return [
      ...masters.map(master => ({ master, slaves: byMaster.get(master.id) ?? [] })),
      ...unassigned.map(slave => ({ master: null as BrokerAccount | null, slaves: [slave] })),
    ]
  }, [links, masterIds, masters, slaves])

  const totalPages = Math.max(1, Math.ceil(groups.length / pageSize))
  const currentPage = Math.min(page, totalPages)
  const pageGroups = groups.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  const rangeStart = groups.length === 0 ? 0 : (currentPage - 1) * pageSize + 1
  const rangeEnd = Math.min(currentPage * pageSize, groups.length)

  const setAccountActive = (brokerId: string, active: boolean) => {
    void toggleBrokerActive(brokerId, active).then(result => {
      if (result.error) setError(result.error)
    })
  }

  const openSlaveChooser = (masterId: string) => {
    setSlaveForMasterId(masterId)
    setChooser('slave')
  }

  const configuringLink = configuringSlaveId
    ? links.find(item => item.destination_broker_account_id === configuringSlaveId) ?? null
    : null
  const configuringSlave = configuringSlaveId
    ? slaves.find(broker => broker.id === configuringSlaveId) ?? null
    : null
  const configuringSource = configuringLink
    ? masters.find(master => master.id === configuringLink.source_broker_account_id) ?? null
    : null

  return (
    <PageShell maxWidth="xl">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <PageHeader title={copy.title} />
        <Button type="button" size="sm" onClick={() => setChooser('master')}>{copy.addMaster}</Button>
      </div>
      {error ? <Alert variant="error">{error}</Alert> : null}
      {groups.length === 0 ? (
        <Card>
          <p className="text-sm text-neutral-900 dark:text-neutral-50">{copy.mastersEmpty}</p>
        </Card>
      ) : (
        <Card padding="none" className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-sm">
              <thead>
                <tr className="border-b border-neutral-100 text-left text-xs font-medium text-neutral-900 dark:border-neutral-800 dark:text-neutral-50">
                  <th className="px-4 py-3">{copy.colAccount}</th>
                  <th className="px-3 py-3">{copy.colCopyFrom}</th>
                  <th className="px-3 py-3">{copy.colRiskType}</th>
                  <th className="px-3 py-3">{copy.colRiskSetting}</th>
                  <th className="px-3 py-3">{copy.colStatus}</th>
                  <th className="px-4 py-3">{copy.colActions}</th>
                </tr>
              </thead>
              {pageGroups.map(group => {
                const expanded = group.master ? !collapsedMasterIds.includes(group.master.id) : true
                return (
                  <tbody key={group.master?.id ?? group.slaves[0]?.id}>
                    {group.master ? (
                      <MasterRow
                        broker={group.master}
                        copy={copy}
                        expanded={expanded}
                        onToggleExpand={() => {
                          const id = group.master!.id
                          setCollapsedMasterIds(prev => (
                            prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]
                          ))
                        }}
                        onAddSlave={() => openSlaveChooser(group.master!.id)}
                        onActiveChange={active => setAccountActive(group.master!.id, active)}
                        onDelete={() => removeMaster(group.master!.id)}
                      />
                    ) : null}
                    {expanded ? group.slaves.map(slave => {
                      const link = links.find(item => item.destination_broker_account_id === slave.id)
                      const source = link ? masters.find(master => master.id === link.source_broker_account_id) : undefined
                      return (
                        <SlaveRow
                          key={slave.id}
                          broker={slave}
                          source={source}
                          link={link}
                          linkState={link ? linkStates[link.id] : undefined}
                          copyBusy={link != null && busyLinkId === link.id}
                          removing={removingSlaveId === slave.id}
                          copy={copy}
                          modes={t.copyRisk.modes}
                          emergencyLabel={link?.manual_settings.copy_risk?.protection.emergency_stop ? t.copyRisk.resumeEmergency : t.copyRisk.emergencyStop}
                          onCopyingChange={next => { if (link) changeCopying(link, next) }}
                          onConfigure={() => {
                            setConfigSaveError(null)
                            setConfiguringSlaveId(slave.id)
                          }}
                          onActiveChange={active => setAccountActive(slave.id, active)}
                          onDelete={() => removeSlave(slave.id)}
                          onEmergency={() => setSlaveEmergency(slave.id, link?.manual_settings.copy_risk?.protection.emergency_stop !== true)}
                        />
                      )
                    }) : null}
                  </tbody>
                )
              })}
            </table>
          </div>
          <div className="flex flex-col gap-3 border-t border-neutral-100 px-4 py-3 text-xs text-neutral-900 sm:flex-row sm:items-center sm:justify-between dark:border-neutral-800 dark:text-neutral-50">
            <div className="flex items-center gap-2">
              <span>{copy.resultPerPage}</span>
              <select
                className="rounded-lg border border-neutral-200 bg-white px-2 py-1 text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-50"
                value={pageSize}
                onChange={event => {
                  setPageSize(Number(event.target.value))
                  setPage(1)
                }}
              >
                {[10, 25, 50].map(size => (
                  <option key={size} value={size}>{size}</option>
                ))}
              </select>
              <span>
                {interpolate(copy.pageStatus, { start: rangeStart, end: rangeEnd, total: groups.length })}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" variant="secondary" size="sm" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>
                {copy.back}
              </Button>
              <span className="inline-flex h-8 min-w-8 items-center justify-center rounded-lg bg-green-400 px-2 font-medium text-neutral-950">
                {currentPage}
              </span>
              <Button type="button" variant="secondary" size="sm" disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)}>
                {copy.next}
              </Button>
            </div>
          </div>
        </Card>
      )}
      {chooser ? (
        <AccountChooser
          title={chooser === 'master' ? copy.addMaster : copy.addSlave}
          brokers={chooser === 'slave' && slaveForMasterId
            ? brokers.filter(broker => (
              broker.copy_source !== true
              && !links.some(link => (
                link.destination_broker_account_id === broker.id
                && link.source_broker_account_id === slaveForMasterId
              ))
            ))
            : availableAccounts}
          emptyLabel={copy.noAccounts}
          connectLabel={copy.connectNew}
          closeLabel={closeLabel}
          loginLabel={copy.login}
          onClose={() => {
            setChooser(null)
            setSlaveForMasterId(null)
          }}
          onSelect={brokerId => {
            const masterId = slaveForMasterId
            setChooser(null)
            setSlaveForMasterId(null)
            if (chooser === 'master') promoteMaster(brokerId)
            else selectSlaveAccount(brokerId, masterId)
          }}
          onConnectNew={() => {
            const role = chooser
            const masterId = slaveForMasterId
            setChooser(null)
            setSlaveForMasterId(null)
            if (role === 'master') {
              assignAfterConnectRef.current = null
              openAddTradingAccount({ asCopySource: true })
              return
            }
            assignAfterConnectRef.current = masterId
            openAddTradingAccount({ asDestination: true })
          }}
        />
      ) : null}
      {channelConflict ? (
        <SlaveChannelConflictModal
          brokerLabel={(() => {
            const broker = brokers.find(item => item.id === channelConflict.brokerId)
            return broker ? accountTitle(broker) : 'Account'
          })()}
          channels={channelConflict.channels}
          labels={{
            title: copy.slaveChannelConflictTitle,
            body: copy.slaveChannelConflictBody,
            channelsLabel: copy.slaveChannelConflictChannelsLabel,
            useDifferent: copy.slaveChannelConflictUseDifferent,
            disconnect: copy.slaveChannelConflictDisconnect,
            disconnecting: copy.slaveChannelConflictDisconnecting,
          }}
          closeLabel={closeLabel}
          busy={channelConflictBusy}
          error={channelConflictError}
          onUseDifferentAccount={() => {
            const masterId = channelConflict.masterId
            setChannelConflict(null)
            if (masterId) {
              setSlaveForMasterId(masterId)
              setChooser('slave')
            }
          }}
          onDisconnectChannels={() => void disconnectChannelsAndContinue()}
          onClose={() => setChannelConflict(null)}
        />
      ) : null}
      {configuringSlave && configuringLink ? (
        <SlaveConfigureModal
          key={configuringSlave.id}
          slave={configuringSlave}
          source={configuringSource}
          settings={copyRiskForEditor(configuringLink.manual_settings)}
          labels={t.copyRisk}
          setup={copy.setup}
          loginLabel={copy.login}
          balanceLabel={copy.balance}
          saveError={configSaveError}
          closeLabel={closeLabel}
          symbolMap={configuringLink.manual_settings.symbol_mapping ?? {}}
          onSymbolMapChange={next => patchSlaveSettings(configuringSlave.id, { symbol_mapping: next })}
          onChange={next => patchSlaveSettings(configuringSlave.id, manualSettingsFromCopyRisk(next))}
          onClose={() => setConfiguringSlaveId(null)}
        />
      ) : null}
    </PageShell>
  )
}

function accountTitle(broker: BrokerAccount): string {
  const name = getBrokerDisplayLabel(broker)
  const login = broker.account_login?.trim()
  if (!login || name.includes(login)) return name
  return `${name} - ${login}`
}

function riskCells(
  link: BrokerCopyLinkRow | undefined,
  copy: { riskFixedLot: string; riskBalancePercent: string },
  modes: CopyRiskTranslations['modes'],
): { type: string; setting: string } {
  if (!link) return { type: '—', setting: '—' }
  if (link.manual_settings.copy_risk) {
    const profile = normalizeCopyRisk(link.manual_settings.copy_risk)
    return { type: modes[profile.sizing.mode], setting: mirrorSizingValue(profile) }
  }
  if (link.manual_settings.risk_mode === 'dynamic_balance_percent') {
    return {
      type: copy.riskBalancePercent,
      setting: `${link.manual_settings.dynamic_balance_percent ?? 1}%`,
    }
  }
  return {
    type: copy.riskFixedLot,
    setting: String(link.manual_settings.fixed_lot ?? 0.01),
  }
}

function RowAction({
  children,
  onClick,
  danger = false,
  disabled = false,
  label,
}: {
  children: ReactNode
  onClick: () => void
  danger?: boolean
  disabled?: boolean
  label: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'inline-flex items-center gap-1 rounded-lg border bg-white px-2.5 py-1 text-xs font-medium dark:bg-neutral-950',
        disabled && 'cursor-not-allowed opacity-50',
        danger
          ? 'border-red-200 text-red-600 hover:bg-red-50 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-950/40'
          : 'border-neutral-200 text-neutral-900 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-50 dark:hover:bg-neutral-900',
      )}
    >
      {children}
    </button>
  )
}

function MasterRow({
  broker,
  copy,
  expanded,
  onToggleExpand,
  onAddSlave,
  onActiveChange,
  onDelete,
}: {
  broker: BrokerAccount
  copy: {
    master: string
    addSlave: string
    pause: string
    resume: string
    delete: string
    expandSlaves: string
    collapseSlaves: string
  }
  expanded: boolean
  onToggleExpand: () => void
  onAddSlave: () => void
  onActiveChange: (active: boolean) => void
  onDelete: () => void
}) {
  const active = broker.is_active !== false
  return (
    <tr className="bg-teal-50/60 dark:bg-teal-950/20">
      <td className="px-4 py-3">
        <div className="flex items-center gap-2.5">
          <AccountMark platform={broker.platform} size="sm" />
          <div className="min-w-0">
            <div className="font-medium text-neutral-900 dark:text-neutral-50">{accountTitle(broker)}</div>
            <Badge variant="success" size="sm">{copy.master}</Badge>
          </div>
        </div>
      </td>
      <td className="px-3 py-3 text-neutral-900 dark:text-neutral-50">—</td>
      <td className="px-3 py-3 text-neutral-900 dark:text-neutral-50">—</td>
      <td className="px-3 py-3 text-neutral-900 dark:text-neutral-50">—</td>
      <td className="px-3 py-3">
        <Toggle checked={active} onChange={onActiveChange} />
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <RowAction label={copy.addSlave} onClick={onAddSlave}>
            <Plus className="h-3.5 w-3.5" />
            {copy.addSlave}
          </RowAction>
          <RowAction label={active ? copy.pause : copy.resume} onClick={() => onActiveChange(!active)}>
            {active ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            {active ? copy.pause : copy.resume}
          </RowAction>
          <RowAction label={copy.delete} danger onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5" />
            {copy.delete}
          </RowAction>
          <RowAction label={expanded ? copy.collapseSlaves : copy.expandSlaves} onClick={onToggleExpand}>
            {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </RowAction>
        </div>
      </td>
    </tr>
  )
}

function SlaveRow({
  broker,
  source,
  link,
  linkState,
  copyBusy,
  removing,
  copy,
  modes,
  emergencyLabel,
  onConfigure,
  onEmergency,
  onActiveChange,
  onCopyingChange,
  onDelete,
}: {
  broker: BrokerAccount
  source?: BrokerAccount
  link?: BrokerCopyLinkRow
  linkState?: MirrorCopyLinkStateRow
  copyBusy: boolean
  removing: boolean
  copy: {
    slave: string
    configure: string
    pause: string
    resume: string
    delete: string
    riskFixedLot: string
    riskBalancePercent: string
    startCopying?: string
    pauseCopying?: string
    stopCopying?: string
    stopCopyingConfirm?: string
    closingCopies?: string
    statusActive?: string
    statusPaused?: string
    statusStopped?: string
    statusStopping?: string
    statusError?: string
  }
  modes: CopyRiskTranslations['modes']
  emergencyLabel: string
  onConfigure: () => void
  onEmergency: () => void
  onActiveChange: (active: boolean) => void
  onCopyingChange: (status: MirrorCopyDesiredStatus) => void
  onDelete: () => void
}) {
  const active = broker.is_active !== false
  const risk = riskCells(link, copy, modes)
  const sourceLogin = source?.account_login?.trim() || (source ? getBrokerDisplayLabel(source) : '—')
  const desired = linkState?.desired_status ?? 'paused'
  const copyingActive = desired === 'active'
  const startLabel = copy.startCopying ?? 'Start copying'
  const pauseLabel = copy.pauseCopying ?? 'Pause copying'
  const stopLabel = copy.stopCopying ?? 'Stop copying'
  const stopConfirm = copy.stopCopyingConfirm ?? STOP_COPYING_CONFIRM_FALLBACK
  const removingLabel = copy.closingCopies ?? 'Closing copied trades…'
  const stopping = desired === 'stopped' && linkState != null && linkState.status !== 'stopped'
  const statusLabel = linkState?.status === 'error'
    || linkState?.status === 'unsupported_provider'
    || linkState?.error_code
    ? (copy.statusError ?? 'Copy error')
    : stopping
      ? (copy.statusStopping ?? 'Stopping…')
      : desired === 'active'
        ? (copy.statusActive ?? 'Copying')
        : desired === 'stopped'
          ? (copy.statusStopped ?? 'Stopped')
          : (copy.statusPaused ?? 'Paused')
  return (
    <tr>
      <td className="border-y border-l border-dashed border-amber-300/80 bg-amber-50/70 px-4 py-3 dark:border-amber-700/50 dark:bg-amber-950/20">
        <div className="flex items-center gap-2.5">
          <AccountMark platform={broker.platform} size="sm" />
          <div className="min-w-0">
            <div className="font-medium text-neutral-900 dark:text-neutral-50">{accountTitle(broker)}</div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="warning" size="sm">{copy.slave}</Badge>
              {linkState ? <Badge variant={mirrorCopyStatusTone(linkState)} size="sm">{statusLabel}</Badge> : null}
            </div>
            {linkState?.error_code ? (
              <div className="mt-1 max-w-[240px] text-[11px] leading-snug text-error-600 dark:text-error-300">
                {linkState.error_code}{linkState.error_detail ? `: ${linkState.error_detail}` : ''}
              </div>
            ) : null}
          </div>
        </div>
      </td>
      <td className="border-y border-dashed border-amber-300/80 bg-amber-50/70 px-3 py-3 dark:border-amber-700/50 dark:bg-amber-950/20">
        {source ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="text-neutral-900 dark:text-neutral-100">{sourceLogin}</span>
            <Badge variant="primary" size="sm">{source.platform || 'MT5'}</Badge>
          </span>
        ) : (
          <span className="text-neutral-900 dark:text-neutral-50">—</span>
        )}
      </td>
      <td className="border-y border-dashed border-amber-300/80 bg-amber-50/70 px-3 py-3 text-neutral-900 dark:border-amber-700/50 dark:bg-amber-950/20 dark:text-neutral-50">
        {risk.type}
      </td>
      <td className="border-y border-dashed border-amber-300/80 bg-amber-50/70 px-3 py-3 text-neutral-900 dark:border-amber-700/50 dark:bg-amber-950/20 dark:text-neutral-50">
        {risk.setting}
      </td>
      <td className="border-y border-dashed border-amber-300/80 bg-amber-50/70 px-3 py-3 dark:border-amber-700/50 dark:bg-amber-950/20">
        <Toggle checked={active} onChange={onActiveChange} disabled={removing} />
      </td>
      <td className="border-y border-r border-dashed border-amber-300/80 bg-amber-50/70 px-4 py-3 dark:border-amber-700/50 dark:bg-amber-950/20">
        <div className="flex flex-wrap items-center gap-1.5">
          <RowAction
            label={copyingActive ? pauseLabel : startLabel}
            disabled={!link || copyBusy || removing}
            onClick={() => onCopyingChange(copyingActive ? 'paused' : 'active')}
          >
            {copyingActive ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            {copyingActive ? pauseLabel : startLabel}
          </RowAction>
          {link && desired !== 'stopped' ? (
            <RowAction
              label={stopLabel}
              danger
              disabled={copyBusy || removing}
              onClick={() => {
                if (window.confirm(stopConfirm)) onCopyingChange('stopped')
              }}
            >
              <Square className="h-3.5 w-3.5" />
              {stopLabel}
            </RowAction>
          ) : null}
          <RowAction label={copy.configure} disabled={!link || removing} onClick={onConfigure}>
            <Settings className="h-3.5 w-3.5" />
            {copy.configure}
          </RowAction>
          <RowAction label={emergencyLabel} disabled={!link || removing} danger={link?.manual_settings.copy_risk?.protection.emergency_stop === true} onClick={onEmergency}>
            <OctagonAlert className="h-3.5 w-3.5" />
            {emergencyLabel}
          </RowAction>
          <RowAction label={active ? copy.pause : copy.resume} disabled={removing} onClick={() => onActiveChange(!active)}>
            {active ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            {active ? copy.pause : copy.resume}
          </RowAction>
          <RowAction label={removing ? removingLabel : copy.delete} danger disabled={removing} onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5" />
            {removing ? removingLabel : copy.delete}
          </RowAction>
        </div>
      </td>
    </tr>
  )
}


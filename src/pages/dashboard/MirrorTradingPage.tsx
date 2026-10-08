import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronUp, Pause, Play, Plus, Settings, Trash2, X } from 'lucide-react'
import clsx from 'clsx'
import { ConfigurationSettingsEditor } from '../../components/configure/ConfigurationSettingsEditor'
import { useAuth } from '../../context/AuthContext'
import { useAddTradingAccount } from '../../context/AddTradingAccountContext'
import { useBrokerAccounts } from '../../context/BrokerAccountsContext'
import { useT } from '../../context/LocaleContext'
import { useSubscription } from '../../context/SubscriptionContext'
import { getBrokerDisplayLabel } from '../../lib/brokerChannelLink'
import {
  connectBrokerCopyLink,
  disconnectBrokerCopyLink,
  fetchBrokerCopyLinks,
  setBrokerCopySource,
  updateBrokerCopyLinkSettings,
  type BrokerCopyLinkRow,
} from '../../lib/brokerCopyLink'
import type { ConfigureModalTranslations } from '../../i18n/locales/configureModal/types'
import type { ConfigurationsPageTranslations } from '../../i18n/locales/types'
import { interpolate } from '../../i18n/interpolate'
import { supabase } from '../../lib/supabase'
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

function platformIconSrc(platform: string): string {
  const raw = platform.trim()
  const file = /^mt[45]$/i.test(raw) ? raw.toUpperCase() : raw || 'MT5'
  return `/${file}.png`
}

function AccountMark({ platform, size = 'md' }: { platform: string; size?: 'sm' | 'md' }) {
  const [failed, setFailed] = useState(false)
  if (failed) return null
  return (
    <img
      src={platformIconSrc(platform)}
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
            className="rounded-lg p-2 text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
            aria-label={closeLabel}
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">
          {brokers.length === 0 ? (
            <p className="text-sm text-neutral-500 dark:text-neutral-400">{emptyLabel}</p>
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
                        <span className="block truncate text-xs text-neutral-500 dark:text-neutral-400">
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
  const { canUseFeature } = useSubscription()
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
        setError(saveError ?? copy.loadError)
        return
      }
      replaceBroker(broker)
      setLinks(prev => prev.filter(link => link.destination_broker_account_id !== brokerId))
      setSlaveIds(prev => prev.filter(id => id !== brokerId))
    })
  }, [copy.loadError, enqueue, replaceBroker, user?.id])

  const addSlave = useCallback((brokerId: string) => {
    enqueue(async () => {
      if (!user?.id) return
      setError(null)
      const current = brokersRef.current.find(broker => broker.id === brokerId)
      if (current?.copy_source === true) {
        const { broker, error: saveError } = await setBrokerCopySource(supabase, user.id, brokerId, false)
        if (saveError || !broker) {
          setError(saveError ?? copy.loadError)
          return
        }
        replaceBroker(broker)
        setLinks(prev => prev.filter(link => link.source_broker_account_id !== brokerId))
      }
      undismissDestination(brokerId)
      setSlaveIds(prev => (prev.includes(brokerId) ? prev : [...prev, brokerId]))
    })
  }, [copy.loadError, enqueue, replaceBroker, undismissDestination, user?.id])

  const removeMaster = useCallback((brokerId: string) => {
    enqueue(async () => {
      if (!user?.id) return
      setError(null)
      const { broker, error: saveError } = await setBrokerCopySource(supabase, user.id, brokerId, false)
      if (saveError || !broker) {
        setError(saveError ?? copy.loadError)
        return
      }
      replaceBroker(broker)
      setLinks(prev => prev.filter(link => link.source_broker_account_id !== brokerId))
      dismissDestination(brokerId)
    })
  }, [copy.loadError, dismissDestination, enqueue, replaceBroker, user?.id])

  const removeSlave = useCallback((brokerId: string) => {
    enqueue(async () => {
      if (!user?.id) return
      setError(null)
      const existing = linksRef.current.filter(link => link.destination_broker_account_id === brokerId)
      for (const link of existing) {
        const { error: saveError } = await disconnectBrokerCopyLink(
          supabase,
          user.id,
          link.source_broker_account_id,
          brokerId,
        )
        if (saveError) {
          setError(saveError)
          return
        }
      }
      setLinks(prev => prev.filter(link => link.destination_broker_account_id !== brokerId))
      setSlaveIds(prev => prev.filter(id => id !== brokerId))
    })
  }, [enqueue, user?.id])

  const assignMaster = useCallback((slaveId: string, masterId: string) => {
    enqueue(async () => {
      if (!user?.id) return
      setError(null)
      const existing = linksRef.current.filter(link => link.destination_broker_account_id === slaveId)
      for (const link of existing) {
        if (link.source_broker_account_id === masterId) continue
        const { error: saveError } = await disconnectBrokerCopyLink(
          supabase,
          user.id,
          link.source_broker_account_id,
          slaveId,
        )
        if (saveError) {
          setError(saveError)
          return
        }
      }
      setLinks(prev => prev.filter(link =>
        link.destination_broker_account_id !== slaveId || link.source_broker_account_id === masterId,
      ))
      if (!masterId || existing.some(link => link.source_broker_account_id === masterId)) return
      const { link, error: saveError } = await connectBrokerCopyLink(supabase, user.id, masterId, slaveId)
      if (saveError || !link) {
        setError(saveError ?? copy.loadError)
        return
      }
      undismissDestination(slaveId)
      setLinks(prev => (prev.some(item => item.id === link.id) ? prev : [...prev, link]))
    })
  }, [copy.loadError, enqueue, undismissDestination, user?.id])

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
    for (const id of ids) {
      addSlave(id)
      if (masterId) assignMaster(id, masterId)
    }
  }, [addSlave, assignMaster, clearPendingDestinationBrokers, pendingDestinationBrokers, user?.id])

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
          <p className="text-sm text-neutral-500 dark:text-neutral-400">{copy.mastersEmpty}</p>
        </Card>
      ) : (
        <Card padding="none" className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-sm">
              <thead>
                <tr className="border-b border-neutral-100 text-left text-xs font-medium text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
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
                          copy={copy}
                          onConfigure={() => {
                            setConfigSaveError(null)
                            setConfiguringSlaveId(slave.id)
                          }}
                          onActiveChange={active => setAccountActive(slave.id, active)}
                          onDelete={() => removeSlave(slave.id)}
                        />
                      )
                    }) : null}
                  </tbody>
                )
              })}
            </table>
          </div>
          <div className="flex flex-col gap-3 border-t border-neutral-100 px-4 py-3 text-xs text-neutral-500 sm:flex-row sm:items-center sm:justify-between dark:border-neutral-800 dark:text-neutral-400">
            <div className="flex items-center gap-2">
              <span>{copy.resultPerPage}</span>
              <select
                className="rounded-lg border border-neutral-200 bg-white px-2 py-1 text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
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
              <span className="inline-flex h-8 min-w-8 items-center justify-center rounded-lg bg-teal-600 px-2 font-medium text-white">
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
            else {
              addSlave(brokerId)
              if (masterId) assignMaster(brokerId, masterId)
            }
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
      {configuringSlave && configuringLink ? (
        <SlaveConfigureDialog
          slave={configuringSlave}
          source={configuringSource}
          settings={configuringLink.manual_settings}
          copy={t.configurationsPage}
          modalCopy={t.accountConfig.configureModal}
          closeLabel={closeLabel}
          title={copy.configure}
          multiTradeEnabled={canUseFeature('multi_trade_style')}
          saveError={configSaveError}
          onPatch={patch => patchSlaveSettings(configuringSlave.id, patch)}
          onError={setConfigSaveError}
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
): { type: string; setting: string } {
  if (!link) return { type: '—', setting: '—' }
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
          : 'border-neutral-200 text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-900',
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
      <td className="px-3 py-3 text-neutral-400">—</td>
      <td className="px-3 py-3 text-neutral-400">—</td>
      <td className="px-3 py-3 text-neutral-400">—</td>
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
  copy,
  onConfigure,
  onActiveChange,
  onDelete,
}: {
  broker: BrokerAccount
  source?: BrokerAccount
  link?: BrokerCopyLinkRow
  copy: {
    slave: string
    configure: string
    pause: string
    resume: string
    delete: string
    riskFixedLot: string
    riskBalancePercent: string
  }
  onConfigure: () => void
  onActiveChange: (active: boolean) => void
  onDelete: () => void
}) {
  const active = broker.is_active !== false
  const risk = riskCells(link, copy)
  const sourceLogin = source?.account_login?.trim() || (source ? getBrokerDisplayLabel(source) : '—')
  return (
    <tr>
      <td className="border-y border-l border-dashed border-amber-300/80 bg-amber-50/70 px-4 py-3 dark:border-amber-700/50 dark:bg-amber-950/20">
        <div className="flex items-center gap-2.5">
          <AccountMark platform={broker.platform} size="sm" />
          <div className="min-w-0">
            <div className="font-medium text-neutral-900 dark:text-neutral-50">{accountTitle(broker)}</div>
            <Badge variant="warning" size="sm">{copy.slave}</Badge>
          </div>
        </div>
      </td>
      <td className="border-y border-dashed border-amber-300/80 bg-amber-50/70 px-3 py-3 dark:border-amber-700/50 dark:bg-amber-950/20">
        {source ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="text-neutral-800 dark:text-neutral-100">{sourceLogin}</span>
            <Badge variant="primary" size="sm">{source.platform || 'MT5'}</Badge>
          </span>
        ) : (
          <span className="text-neutral-400">—</span>
        )}
      </td>
      <td className="border-y border-dashed border-amber-300/80 bg-amber-50/70 px-3 py-3 text-neutral-700 dark:border-amber-700/50 dark:bg-amber-950/20 dark:text-neutral-200">
        {risk.type}
      </td>
      <td className="border-y border-dashed border-amber-300/80 bg-amber-50/70 px-3 py-3 text-neutral-700 dark:border-amber-700/50 dark:bg-amber-950/20 dark:text-neutral-200">
        {risk.setting}
      </td>
      <td className="border-y border-dashed border-amber-300/80 bg-amber-50/70 px-3 py-3 dark:border-amber-700/50 dark:bg-amber-950/20">
        <Toggle checked={active} onChange={onActiveChange} />
      </td>
      <td className="border-y border-r border-dashed border-amber-300/80 bg-amber-50/70 px-4 py-3 dark:border-amber-700/50 dark:bg-amber-950/20">
        <div className="flex flex-wrap items-center gap-1.5">
          <RowAction label={copy.configure} disabled={!link} onClick={onConfigure}>
            <Settings className="h-3.5 w-3.5" />
            {copy.configure}
          </RowAction>
          <RowAction label={active ? copy.pause : copy.resume} onClick={() => onActiveChange(!active)}>
            {active ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            {active ? copy.pause : copy.resume}
          </RowAction>
          <RowAction label={copy.delete} danger onClick={onDelete}>
            <Trash2 className="h-3.5 w-3.5" />
            {copy.delete}
          </RowAction>
        </div>
      </td>
    </tr>
  )
}

function SlaveConfigureDialog({
  slave,
  source,
  settings,
  copy,
  modalCopy,
  closeLabel,
  title,
  multiTradeEnabled,
  saveError,
  onPatch,
  onError,
  onClose,
}: {
  slave: BrokerAccount
  source: BrokerAccount | null
  settings: ManualSettings
  copy: ConfigurationsPageTranslations
  modalCopy: ConfigureModalTranslations
  closeLabel: string
  title: string
  multiTradeEnabled: boolean
  saveError: string | null
  onPatch: (patch: Partial<ManualSettings>) => void
  onError: (message: string) => void
  onClose: () => void
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
      aria-labelledby="mirror-slave-configure-title"
    >
      <button type="button" className="absolute inset-0 bg-neutral-950/55" aria-label={closeLabel} onClick={onClose} />
      <div className="relative flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl border border-neutral-200/65 bg-white shadow-2xl dark:border-neutral-800/55 dark:bg-neutral-950 sm:max-w-2xl sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-neutral-100 px-5 py-4 dark:border-neutral-800">
          <div className="min-w-0">
            <h2 id="mirror-slave-configure-title" className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
              {title}
            </h2>
            <p className="mt-2 flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300">
              <AccountMark platform={slave.platform} size="sm" />
              <span className="truncate">{accountTitle(slave)}</span>
            </p>
            {source ? (
              <p className="mt-1 truncate text-xs text-neutral-500 dark:text-neutral-400">
                {copy.copyFrom} {accountTitle(source)}
              </p>
            ) : null}
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
            broker={slave}
            settings={settings}
            copy={copy}
            modalCopy={modalCopy}
            multiTradeEnabled={multiTradeEnabled}
            saveError={saveError}
            onPatch={onPatch}
            onError={onError}
          />
        </div>
        <div className="flex justify-end border-t border-neutral-100 px-5 py-4 dark:border-neutral-800">
          <button
            type="button"
            className="rounded-lg px-4 py-2 text-sm font-medium text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
            onClick={onClose}
          >
            {closeLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

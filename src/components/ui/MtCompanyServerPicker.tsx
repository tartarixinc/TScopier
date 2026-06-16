import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { ArrowLeft, Check, ChevronRight, Search, X } from 'lucide-react'
import { useT } from '../../context/LocaleContext'
import { interpolate } from '../../i18n/interpolate'
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss'
import { partitionBrokerSearchResults } from '../../lib/brokerSearchResults'
import { fxsocketBroker, type BrokerSearchCompany } from '../../lib/fxsocketBroker'

const MAX_SERVER_HITS = 40
const MAX_COMPANY_HITS = 20
const SEARCH_DEBOUNCE_MS = 400

interface MtCompanyServerPickerProps {
  value: string
  onChange: (value: string) => void
  platform?: 'MT4' | 'MT5'
  label?: string
  hint?: string
  required?: boolean
}

function companyShortLabel(company: BrokerSearchCompany): string {
  const names = (company.results ?? [])
    .map(r => (r.name ?? '').trim())
    .filter(Boolean)
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]
  let prefix = names[0]
  for (const name of names.slice(1)) {
    while (prefix && !name.startsWith(prefix)) {
      prefix = prefix.slice(0, -1)
    }
  }
  const trimmed = prefix.replace(/[-_.]+$/, '')
  return trimmed || names[0]
}

function companyKey(company: BrokerSearchCompany, index: number): string {
  return `${company.companyName ?? 'company'}-${index}`
}

interface BrokerServerPickerModalProps {
  open: boolean
  value: string
  platform: 'MT4' | 'MT5'
  resolvedLabel: string
  onClose: () => void
  onSelect: (serverName: string) => void
  onManualEntry: () => void
}

const BrokerServerPickerModal = memo(function BrokerServerPickerModal({
  open,
  value,
  platform,
  resolvedLabel,
  onClose,
  onSelect,
  onManualEntry,
}: BrokerServerPickerModalProps) {
  const t = useT()
  const cf = t.accountConfig.connectForm

  const [step, setStep] = useState<'company' | 'server'>('company')
  const [searchQuery, setSearchQuery] = useState('')
  const [companies, setCompanies] = useState<BrokerSearchCompany[]>([])
  const [selectedCompany, setSelectedCompany] = useState<BrokerSearchCompany | null>(null)
  const [loading, setLoading] = useState(false)
  const [searchError, setSearchError] = useState('')

  const overlayRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchSeqRef = useRef(0)

  const deferredQuery = useDeferredValue(searchQuery.trim())

  const reset = useCallback(() => {
    setStep('company')
    setSearchQuery('')
    setCompanies([])
    setSelectedCompany(null)
    setLoading(false)
    setSearchError('')
  }, [])

  useEffect(() => {
    if (!open) {
      reset()
      return
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, onClose, reset])

  useEffect(() => {
    if (!open || step !== 'company') return
    const timer = window.setTimeout(() => searchInputRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [open, step])

  useEffect(() => {
    if (!open || step !== 'company') return
    const q = searchQuery.trim()
    if (q.length < 4) {
      setCompanies([])
      setLoading(false)
      setSearchError('')
      return
    }

    const seq = ++searchSeqRef.current
    setLoading(true)
    setSearchError('')

    const timer = window.setTimeout(() => {
      void fxsocketBroker
        .searchBrokers({ company: q, platform })
        .then(({ companies: next }) => {
          if (seq !== searchSeqRef.current) return
          setCompanies(next)
        })
        .catch(() => {
          if (seq !== searchSeqRef.current) return
          setCompanies([])
          setSearchError(cf.brokerCompanySearchError)
        })
        .finally(() => {
          if (seq !== searchSeqRef.current) return
          setLoading(false)
        })
    }, SEARCH_DEBOUNCE_MS)

    return () => window.clearTimeout(timer)
  }, [open, step, searchQuery, cf.brokerCompanySearchError, platform])

  const handleCompanySelect = useCallback((company: BrokerSearchCompany) => {
    setSelectedCompany(company)
    setStep('server')
  }, [])

  const handleBackToCompanies = useCallback(() => {
    setStep('company')
    setSelectedCompany(null)
  }, [])

  const servers = useMemo(
    () => (selectedCompany?.results ?? [])
      .map(r => (r.name ?? '').trim())
      .filter(Boolean),
    [selectedCompany],
  )

  const showMinCharsHint = deferredQuery.length > 0 && deferredQuery.length < 4
  const { serverHits, companyHits } = useMemo(
    () => partitionBrokerSearchResults(deferredQuery, companies),
    [deferredQuery, companies],
  )
  const visibleServerHits = useMemo(
    () => serverHits.slice(0, MAX_SERVER_HITS),
    [serverHits],
  )
  const visibleCompanyHits = useMemo(
    () => companyHits.slice(0, MAX_COMPANY_HITS),
    [companyHits],
  )
  const companyLabels = useMemo(
    () => visibleCompanyHits.map(company => companyShortLabel(company)),
    [visibleCompanyHits],
  )
  const hasResults = serverHits.length > 0 || companyHits.length > 0
  const resultsStale = deferredQuery !== searchQuery.trim()

  const handleUseSearchQueryAsServer = useCallback(() => {
    const q = searchQuery.trim()
    if (q.length < 4) return
    onSelect(q)
  }, [onSelect, searchQuery])

  const { onOverlayMouseDown, onOverlayClick } = useOverlayDismiss(overlayRef, backdropRef, onClose)

  if (!open) return null

  const useQueryButton = searchQuery.trim().length >= 4 ? (
    <button
      type="button"
      onClick={handleUseSearchQueryAsServer}
      className="w-full rounded-xl border border-teal-200 bg-teal-50 px-4 py-3 text-left text-sm font-medium text-teal-900 transition-colors hover:bg-teal-100 dark:border-teal-900/50 dark:bg-teal-950/40 dark:text-teal-100 dark:hover:bg-teal-950/60"
    >
      {interpolate(cf.brokerCompanySearchUseQuery, { query: searchQuery.trim() })}
    </button>
  ) : null

  const modal = (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center p-0 sm:p-6"
      onMouseDown={onOverlayMouseDown}
      onClick={onOverlayClick}
    >
      <div ref={backdropRef} className="absolute inset-0 bg-neutral-950/50" aria-hidden />

      <div className="relative flex max-h-[85vh] w-full flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl sm:max-w-md sm:rounded-3xl dark:bg-neutral-900">
        <div className="flex items-center gap-3 border-b border-neutral-100 px-4 py-4 dark:border-neutral-800">
          {step === 'server' ? (
            <button
              type="button"
              onClick={handleBackToCompanies}
              aria-label={t.common.previous}
              className="rounded-xl p-2 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          ) : (
            <div className="w-9" />
          )}
          <h2 className="flex-1 text-center text-base font-semibold text-neutral-900 dark:text-neutral-50">
            {step === 'server' ? cf.brokerServerPickerTitle : resolvedLabel}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t.common.cancel}
            className="rounded-xl p-2 text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {step === 'company' ? (
          <>
            <div className="border-b border-neutral-100 px-4 py-3 dark:border-neutral-800">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder={cf.brokerCompanySearchPlaceholder}
                  className="w-full rounded-xl border border-neutral-200 bg-neutral-50 py-2.5 pl-9 pr-9 text-sm text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-neutral-800 dark:bg-neutral-800/50 dark:text-neutral-50"
                />
                {searchQuery ? (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-neutral-400 hover:text-neutral-600"
                    aria-label={t.common.cancel}
                  >
                    <X className="h-4 w-4" />
                  </button>
                ) : null}
              </div>
            </div>

            <div className="min-h-[280px] flex-1 overflow-y-auto">
              {loading || resultsStale ? (
                <div className="px-4 py-8 text-center text-sm text-neutral-500 dark:text-neutral-400">
                  {cf.brokerCompanySearchLoading}
                </div>
              ) : searchError ? (
                <div className="space-y-4 px-4 py-8">
                  <p className="text-center text-sm text-error-600 dark:text-error-400">
                    {searchError}
                  </p>
                  {useQueryButton}
                </div>
              ) : showMinCharsHint ? (
                <div className="px-4 py-8 text-center text-sm text-neutral-500 dark:text-neutral-400">
                  {cf.brokerCompanySearchMinChars}
                </div>
              ) : deferredQuery.length >= 4 && !hasResults ? (
                <div className="space-y-4 px-4 py-8">
                  <p className="text-center text-sm text-neutral-500 dark:text-neutral-400">
                    {cf.brokerCompanySearchNoResults}
                  </p>
                  {useQueryButton}
                </div>
              ) : hasResults ? (
                <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {visibleServerHits.length > 0 ? (
                    <div>
                      <p className="px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                        {cf.brokerCompanySearchServersHeading}
                        {serverHits.length > MAX_SERVER_HITS
                          ? ` (${visibleServerHits.length}/${serverHits.length})`
                          : ''}
                      </p>
                      <ul>
                        {visibleServerHits.map(hit => (
                          <li key={hit.serverName}>
                            <button
                              type="button"
                              onClick={() => onSelect(hit.serverName)}
                              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-50">
                                  {hit.serverName}
                                </div>
                                {hit.companyName ? (
                                  <div className="mt-0.5 truncate text-xs text-neutral-500 dark:text-neutral-400">
                                    {hit.companyName}
                                  </div>
                                ) : null}
                              </div>
                              {value === hit.serverName ? (
                                <Check className="h-4 w-4 shrink-0 text-teal-600 dark:text-teal-400" />
                              ) : (
                                <ChevronRight className="h-4 w-4 shrink-0 text-neutral-300 dark:text-neutral-600" />
                              )}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {visibleCompanyHits.length > 0 ? (
                    <div>
                      <p className="px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                        {cf.brokerCompanySearchCompaniesHeading}
                        {companyHits.length > MAX_COMPANY_HITS
                          ? ` (${visibleCompanyHits.length}/${companyHits.length})`
                          : ''}
                      </p>
                      <ul>
                        {visibleCompanyHits.map((company, index) => {
                          const shortLabel = companyLabels[index] ?? ''
                          return (
                            <li key={companyKey(company, index)}>
                              <button
                                type="button"
                                onClick={() => handleCompanySelect(company)}
                                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-sm font-medium text-neutral-900 dark:text-neutral-50">
                                    {company.companyName || shortLabel || '—'}
                                  </div>
                                  {shortLabel && company.companyName ? (
                                    <div className="mt-0.5 truncate text-xs text-neutral-500 dark:text-neutral-400">
                                      {shortLabel}
                                    </div>
                                  ) : null}
                                </div>
                                <ChevronRight className="h-4 w-4 shrink-0 text-neutral-300 dark:text-neutral-600" />
                              </button>
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="px-4 py-10 text-center">
                  <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-neutral-100 dark:bg-neutral-800">
                    <Search className="h-7 w-7 text-neutral-300 dark:text-neutral-600" />
                  </div>
                  <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                    {cf.brokerCompanySearchEmpty}
                  </p>
                  <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
                    {cf.brokerCompanySearchMinChars}
                  </p>
                </div>
              )}
            </div>

            <div className="border-t border-neutral-100 px-4 py-3 dark:border-neutral-800">
              <button
                type="button"
                onClick={onManualEntry}
                className="w-full text-center text-xs text-neutral-500 hover:text-teal-600 dark:text-neutral-400 dark:hover:text-teal-400"
              >
                {cf.brokerServerManualToggle}
              </button>
            </div>
          </>
        ) : (
          <ul className="flex-1 divide-y divide-neutral-100 overflow-y-auto dark:divide-neutral-800">
            {servers.map(server => (
              <li key={server}>
                <button
                  type="button"
                  onClick={() => onSelect(server)}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
                >
                  <span className="text-sm text-neutral-900 dark:text-neutral-50">{server}</span>
                  {value === server ? (
                    <Check className="h-4 w-4 shrink-0 text-teal-600 dark:text-teal-400" />
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )

  return createPortal(modal, document.body)
})

export function MtCompanyServerPicker({
  value,
  onChange,
  platform = 'MT5',
  label,
  hint,
  required,
}: MtCompanyServerPickerProps) {
  const t = useT()
  const cf = t.accountConfig.connectForm
  const resolvedLabel = label ?? cf.brokerServerLabel

  const [modalOpen, setModalOpen] = useState(false)
  const [manualMode, setManualMode] = useState(false)
  const [manualServer, setManualServer] = useState('')

  useEffect(() => {
    if (manualMode) {
      onChange(manualServer.trim())
    }
  }, [manualMode, manualServer, onChange])

  const openModal = useCallback(() => {
    setModalOpen(true)
  }, [])

  const closeModal = useCallback(() => {
    setModalOpen(false)
  }, [])

  const handleSelect = useCallback((serverName: string) => {
    onChange(serverName)
    setManualMode(false)
    setManualServer('')
    setModalOpen(false)
  }, [onChange])

  const handleManualEntry = useCallback(() => {
    setModalOpen(false)
    setManualMode(true)
    setManualServer(value)
  }, [value])

  return (
    <div className="flex flex-col gap-1.5">
      {resolvedLabel ? (
        <label className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
          {resolvedLabel}
          {required ? <span className="text-error-500"> *</span> : null}
        </label>
      ) : null}

      {manualMode ? (
        <div className="space-y-2">
          <input
            type="text"
            value={manualServer}
            required={required}
            onChange={e => setManualServer(e.target.value)}
            placeholder={cf.brokerServerManualLabel}
            className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 hover:border-neutral-300 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-50"
          />
          <button
            type="button"
            onClick={() => {
              setManualMode(false)
              setManualServer('')
              onChange('')
            }}
            className="text-xs text-teal-600 hover:underline dark:text-teal-400"
          >
            {cf.brokerServerSelectPrompt}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={openModal}
          className={clsx(
            'flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-colors',
            'border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900',
            'hover:border-neutral-300 dark:hover:border-neutral-700',
            'focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary-500',
          )}
        >
          <span className={clsx(value ? 'text-neutral-900 dark:text-neutral-50' : 'text-neutral-400')}>
            {value || cf.brokerServerSelectPrompt}
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-neutral-400" />
        </button>
      )}

      {!manualMode ? (
        <button
          type="button"
          onClick={() => {
            setManualMode(true)
            setManualServer(value)
          }}
          className="self-start text-xs text-neutral-500 hover:text-teal-600 hover:underline dark:text-neutral-400 dark:hover:text-teal-400"
        >
          {cf.brokerServerManualToggle}
        </button>
      ) : null}

      {hint && !manualMode ? (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{hint}</p>
      ) : null}
      {manualMode ? (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{cf.brokerServerManualHint}</p>
      ) : null}

      <BrokerServerPickerModal
        open={modalOpen}
        value={value}
        platform={platform}
        resolvedLabel={resolvedLabel}
        onClose={closeModal}
        onSelect={handleSelect}
        onManualEntry={handleManualEntry}
      />
    </div>
  )
}

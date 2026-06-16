import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { ArrowLeft, Check, ChevronRight, Search, X } from 'lucide-react'
import { useT } from '../../context/LocaleContext'
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss'
import { fxsocketBroker, type BrokerSearchCompany } from '../../lib/fxsocketBroker'

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
  const [step, setStep] = useState<'company' | 'server'>('company')
  const [searchQuery, setSearchQuery] = useState('')
  const [companies, setCompanies] = useState<BrokerSearchCompany[]>([])
  const [selectedCompany, setSelectedCompany] = useState<BrokerSearchCompany | null>(null)
  const [loading, setLoading] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [manualMode, setManualMode] = useState(false)
  const [manualServer, setManualServer] = useState('')

  const overlayRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchSeqRef = useRef(0)

  const resetModal = useCallback(() => {
    setStep('company')
    setSearchQuery('')
    setCompanies([])
    setSelectedCompany(null)
    setLoading(false)
    setSearchError('')
  }, [])

  const openModal = () => {
    resetModal()
    setModalOpen(true)
  }

  const closeModal = useCallback(() => {
    setModalOpen(false)
    resetModal()
  }, [resetModal])

  const { onOverlayMouseDown, onOverlayClick } = useOverlayDismiss(overlayRef, backdropRef, closeModal)

  useEffect(() => {
    if (manualMode) {
      onChange(manualServer.trim())
    }
  }, [manualMode, manualServer, onChange])

  useEffect(() => {
    if (!modalOpen) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeModal()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [modalOpen, closeModal])

  useEffect(() => {
    document.body.style.overflow = modalOpen ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [modalOpen])

  useEffect(() => {
    if (!modalOpen || step !== 'company') return
    searchInputRef.current?.focus()
  }, [modalOpen, step])

  useEffect(() => {
    if (!modalOpen || step !== 'company') return
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
    }, 300)

    return () => window.clearTimeout(timer)
  }, [modalOpen, step, searchQuery, cf.brokerCompanySearchError, platform])

  const handleCompanySelect = (company: BrokerSearchCompany) => {
    setSelectedCompany(company)
    setStep('server')
  }

  const handleServerSelect = (serverName: string) => {
    onChange(serverName)
    setManualMode(false)
    setManualServer('')
    closeModal()
  }

  const handleBackToCompanies = () => {
    setStep('company')
    setSelectedCompany(null)
  }

  const servers = (selectedCompany?.results ?? [])
    .map(r => (r.name ?? '').trim())
    .filter(Boolean)

  const trimmedQuery = searchQuery.trim()
  const showMinCharsHint = trimmedQuery.length > 0 && trimmedQuery.length < 4

  return (
    <div className="flex flex-col gap-1.5">
      {resolvedLabel && (
        <label className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
          {resolvedLabel}
          {required && <span className="text-error-500"> *</span>}
        </label>
      )}

      {manualMode ? (
        <div className="space-y-2">
          <input
            type="text"
            value={manualServer}
            required={required}
            onChange={e => setManualServer(e.target.value)}
            placeholder={cf.brokerServerManualLabel}
            className="w-full px-3 py-2 text-sm rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-50 placeholder:text-neutral-400 hover:border-neutral-300 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
          />
          <button
            type="button"
            onClick={() => {
              setManualMode(false)
              setManualServer('')
              onChange('')
            }}
            className="text-xs text-teal-600 dark:text-teal-400 hover:underline"
          >
            {cf.brokerServerSelectPrompt}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={openModal}
          className={clsx(
            'w-full flex items-center justify-between gap-3 px-3 py-2 text-sm rounded-lg border text-left transition-colors',
            'border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900',
            'hover:border-neutral-300 dark:hover:border-neutral-700',
            'focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent',
          )}
        >
          <span className={clsx(value ? 'text-neutral-900 dark:text-neutral-50' : 'text-neutral-400')}>
            {value || cf.brokerServerSelectPrompt}
          </span>
          <ChevronRight className="w-4 h-4 shrink-0 text-neutral-400" />
        </button>
      )}

      {!manualMode && (
        <button
          type="button"
          onClick={() => {
            setManualMode(true)
            setManualServer(value)
          }}
          className="self-start text-xs text-neutral-500 dark:text-neutral-400 hover:text-teal-600 dark:hover:text-teal-400 hover:underline"
        >
          {cf.brokerServerManualToggle}
        </button>
      )}

      {hint && !manualMode && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{hint}</p>
      )}
      {manualMode && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{cf.brokerServerManualHint}</p>
      )}

      {modalOpen && (
        <div
          ref={overlayRef}
          className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-6"
          onMouseDown={onOverlayMouseDown}
          onClick={onOverlayClick}
        >
          <div ref={backdropRef} className="absolute inset-0 bg-neutral-950/40 backdrop-blur-sm" />

          <div className="relative bg-white dark:bg-neutral-900 rounded-t-3xl sm:rounded-3xl shadow-2xl w-full sm:max-w-md max-h-[85vh] flex flex-col overflow-hidden">
            <div className="flex items-center gap-3 px-4 py-4 border-b border-neutral-100 dark:border-neutral-800">
              {step === 'server' ? (
                <button
                  type="button"
                  onClick={handleBackToCompanies}
                  aria-label={t.common.previous}
                  className="p-2 rounded-xl text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  <ArrowLeft className="w-5 h-5" />
                </button>
              ) : (
                <div className="w-9" />
              )}
              <h2 className="flex-1 text-center text-base font-semibold text-neutral-900 dark:text-neutral-50">
                {step === 'server' ? cf.brokerServerPickerTitle : resolvedLabel}
              </h2>
              <button
                type="button"
                onClick={closeModal}
                aria-label={t.common.cancel}
                className="p-2 rounded-xl text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {step === 'company' ? (
              <>
                <div className="px-4 py-3 border-b border-neutral-100 dark:border-neutral-800">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400" />
                    <input
                      ref={searchInputRef}
                      type="text"
                      value={searchQuery}
                      onChange={e => setSearchQuery(e.target.value)}
                      placeholder={cf.brokerCompanySearchPlaceholder}
                      className="w-full pl-9 pr-9 py-2.5 text-sm rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 text-neutral-900 dark:text-neutral-50 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-primary-500"
                    />
                    {searchQuery && (
                      <button
                        type="button"
                        onClick={() => setSearchQuery('')}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-full text-neutral-400 hover:text-neutral-600"
                        aria-label={t.common.cancel}
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto min-h-[280px]">
                  {loading ? (
                    <div className="px-4 py-8 text-sm text-center text-neutral-500 dark:text-neutral-400">
                      {cf.brokerCompanySearchLoading}
                    </div>
                  ) : searchError ? (
                    <div className="px-4 py-8 text-sm text-center text-error-600 dark:text-error-400">
                      {searchError}
                    </div>
                  ) : showMinCharsHint ? (
                    <div className="px-4 py-8 text-sm text-center text-neutral-500 dark:text-neutral-400">
                      {cf.brokerCompanySearchMinChars}
                    </div>
                  ) : trimmedQuery.length >= 4 && companies.length === 0 ? (
                    <div className="px-4 py-8 text-sm text-center text-neutral-500 dark:text-neutral-400">
                      {cf.brokerCompanySearchNoResults}
                    </div>
                  ) : companies.length > 0 ? (
                    <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
                      {companies.map((company, index) => {
                        const shortLabel = companyShortLabel(company)
                        return (
                          <li key={companyKey(company, index)}>
                            <button
                              type="button"
                              onClick={() => handleCompanySelect(company)}
                              className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
                            >
                              <div className="min-w-0 flex-1">
                                <div className="text-sm font-medium text-neutral-900 dark:text-neutral-50 truncate">
                                  {company.companyName || shortLabel || '—'}
                                </div>
                                {shortLabel && company.companyName && (
                                  <div className="text-xs text-neutral-500 dark:text-neutral-400 truncate mt-0.5">
                                    {shortLabel}
                                  </div>
                                )}
                              </div>
                              <ChevronRight className="w-4 h-4 shrink-0 text-neutral-300 dark:text-neutral-600" />
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  ) : (
                    <div className="px-4 py-10 text-center">
                      <div className="mx-auto mb-4 w-16 h-16 rounded-2xl bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center">
                        <Search className="w-7 h-7 text-neutral-300 dark:text-neutral-600" />
                      </div>
                      <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
                        {cf.brokerCompanySearchEmpty}
                      </p>
                      <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-2">
                        {cf.brokerCompanySearchMinChars}
                      </p>
                    </div>
                  )}
                </div>

                <div className="px-4 py-3 border-t border-neutral-100 dark:border-neutral-800">
                  <button
                    type="button"
                    onClick={() => {
                      closeModal()
                      setManualMode(true)
                      setManualServer(value)
                    }}
                    className="w-full text-center text-xs text-neutral-500 dark:text-neutral-400 hover:text-teal-600 dark:hover:text-teal-400"
                  >
                    {cf.brokerServerManualToggle}
                  </button>
                </div>
              </>
            ) : (
              <ul className="flex-1 overflow-y-auto divide-y divide-neutral-100 dark:divide-neutral-800">
                {servers.map(server => (
                  <li key={server}>
                    <button
                      type="button"
                      onClick={() => handleServerSelect(server)}
                      className="w-full flex items-center justify-between gap-3 px-4 py-3.5 text-left hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
                    >
                      <span className="text-sm text-neutral-900 dark:text-neutral-50">{server}</span>
                      {value === server && (
                        <Check className="w-4 h-4 shrink-0 text-teal-600 dark:text-teal-400" />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

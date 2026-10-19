import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import clsx from 'clsx'
import { Loader2, Plus, Trash2, X } from 'lucide-react'
import { useT } from '../../context/LocaleContext'
import { interpolate } from '../../i18n/interpolate'
import { useBrokerAccounts } from '../../context/BrokerAccountsContext'
import { useSubscription } from '../../context/SubscriptionContext'
import { fxsocketBroker } from '../../lib/fxsocketBroker'
import { startCtraderConnect } from '../../lib/ctraderBroker'
import {
  BINANCE_API_MANAGEMENT_URL,
  DEFAULT_BINANCE_SETTINGS_DRAFT,
  linkBinanceAccount,
  parseBinanceSettingsDraft,
  type BinanceEnvironment,
  type BinanceSettingsDraft,
} from '../../lib/binanceBroker'
import {
  DEFAULT_BYBIT_SETTINGS_DRAFT,
  linkBybitAccount,
  parseBybitSettingsDraft,
  type BybitEnvironment,
  type BybitSettingsDraft,
  BYBIT_API_MANAGEMENT_URL,
} from '../../lib/bybitBroker'
import {
  DEFAULT_KUCOIN_SETTINGS_DRAFT,
  linkKucoinAccount,
  parseKucoinSettingsDraft,
  type KucoinSettingsDraft,
  KUCOIN_API_MANAGEMENT_URL,
} from '../../lib/kucoinBroker'
import {
  DEFAULT_DXTRADE_DRAFT,
  linkDxtradeAccount,
  parseDxtradeDraft,
  type DxtradeDraftError,
  type DxtradeLoginDraft,
} from '../../lib/dxtradeBroker'
import { ApiKeyHelp } from './ApiKeyHelp'
import { BinanceSettingsFields } from './BinanceSettingsFields'
import {
  emptyConnectTradingAccountForm,
  type ConnectTradingAccountForm,
} from '../../lib/connectTradingAccountForm'
import {
  inferServerPlatform,
  type TradingPlatform,
} from '../../lib/tradingPlatform'
import {
  connectAccountsBatch,
  emptyConnectRows,
  resolveActiveBrokerCount,
  validateConnectRow,
  type BulkConnectResult,
  type BulkConnectRowProgress,
} from '../../lib/bulkConnectBrokers'
import {
  brokerConnectErrorLabelsFromI18n,
  userFacingBrokerConnectError,
} from '../../lib/brokerConnectError'
import { PasswordInput } from '../auth/PasswordInput'
import { Input } from '../ui/Input'
import { Button } from '../ui/Button'
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss'
import type { BrokerAccount } from '../../types/database'
import { PaywallErrorAlert } from '../billing/PaywallErrorAlert'
import { BulkUploadAccountsModal } from './BulkUploadAccountsModal'
import { ConnectAccountsBatchProgress } from './ConnectAccountsBatchProgress'
import { MtCompanyServerPicker } from '../ui/MtCompanyServerPicker'

type ConnectTradingAccountModalProps = {
  open: boolean
  onClose: () => void
  onSuccess?: (broker: BrokerAccount) => void
  onBatchSuccess?: (result: BulkConnectResult) => void
  /** Platform chosen in the Add account picker. Applied each time the modal opens. */
  initialPlatform?: TradingPlatform | null
  /** Go back to the platform picker. The button is hidden when omitted. */
  onChangePlatform?: () => void
}

type ConnectStep = 0 | 1 | 2

function countValidRows(rows: ConnectTradingAccountForm[]): number {
  return rows.filter(row => validateConnectRow(row) == null).length
}

export function ConnectTradingAccountModal({
  open,
  onClose,
  onSuccess,
  onBatchSuccess,
  initialPlatform,
  onChangePlatform,
}: ConnectTradingAccountModalProps) {
  const t = useT()
  const cf = t.accountConfig.connectForm
  const bc = t.accountConfig.bulkConnect
  const bl = t.accountConfig.brokerList
  const pw = t.pricing.paywall
  const connectErrorLabels = brokerConnectErrorLabelsFromI18n(bl)
  const { brokers, upsertBroker } = useBrokerAccounts()
  const { hasActiveSubscription, limits, usage, isAdmin } = useSubscription()
  const overlayRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const connectStartedAtRef = useRef(0)
  const brokersRef = useRef(brokers)
  brokersRef.current = brokers

  const [rows, setRows] = useState<ConnectTradingAccountForm[]>(() => emptyConnectRows())
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [connectStep, setConnectStep] = useState<ConnectStep>(0)
  const [batchRows, setBatchRows] = useState<BulkConnectRowProgress[]>([])
  const [bulkUploadOpen, setBulkUploadOpen] = useState(false)
  const [binanceKey, setBinanceKey] = useState('')
  const [binanceSecret, setBinanceSecret] = useState('')
  const [binanceLabel, setBinanceLabel] = useState('')
  const [binanceEnv, setBinanceEnv] = useState<BinanceEnvironment>('live')
  const [binanceDraft, setBinanceDraft] = useState<BinanceSettingsDraft>(DEFAULT_BINANCE_SETTINGS_DRAFT)
  const [binanceFieldError, setBinanceFieldError] = useState<'margin' | 'leverage' | null>(null)
  const [bybitKey, setBybitKey] = useState('')
  const [bybitSecret, setBybitSecret] = useState('')
  const [bybitLabel, setBybitLabel] = useState('')
  const [bybitEnv, setBybitEnv] = useState<BybitEnvironment>('live')
  const [bybitDraft, setBybitDraft] = useState<BybitSettingsDraft>(DEFAULT_BYBIT_SETTINGS_DRAFT)
  const [bybitFieldError, setBybitFieldError] = useState<'margin' | 'leverage' | null>(null)
  const [kucoinKey, setKucoinKey] = useState('')
  const [kucoinSecret, setKucoinSecret] = useState('')
  const [kucoinPassphrase, setKucoinPassphrase] = useState('')
  const [kucoinLabel, setKucoinLabel] = useState('')
  const [kucoinDraft, setKucoinDraft] = useState<KucoinSettingsDraft>(DEFAULT_KUCOIN_SETTINGS_DRAFT)
  const [kucoinFieldError, setKucoinFieldError] = useState<'margin' | 'leverage' | null>(null)
  const [dxtradeDraft, setDxtradeDraft] = useState<DxtradeLoginDraft>(DEFAULT_DXTRADE_DRAFT)
  const [dxtradeFieldError, setDxtradeFieldError] = useState<DxtradeDraftError | null>(null)

  const reset = useCallback(() => {
    setRows(emptyConnectRows())
    setError('')
    setSaving(false)
    setConnectStep(0)
    setBatchRows([])
    setBulkUploadOpen(false)
    setBinanceKey('')
    setBinanceSecret('')
    setBinanceLabel('')
    setBinanceEnv('live')
    setBinanceDraft(DEFAULT_BINANCE_SETTINGS_DRAFT)
    setBinanceFieldError(null)
    setBybitKey('')
    setBybitSecret('')
    setBybitLabel('')
    setBybitEnv('live')
    setBybitDraft(DEFAULT_BYBIT_SETTINGS_DRAFT)
    setBybitFieldError(null)
    setKucoinKey('')
    setKucoinSecret('')
    setKucoinPassphrase('')
    setKucoinLabel('')
    setKucoinDraft(DEFAULT_KUCOIN_SETTINGS_DRAFT)
    setKucoinFieldError(null)
    setDxtradeDraft(DEFAULT_DXTRADE_DRAFT)
    setDxtradeFieldError(null)
  }, [])

  const handleClose = useCallback(() => {
    if (saving) return
    reset()
    onClose()
  }, [onClose, reset, saving])

  const { onOverlayMouseDown, onOverlayClick } = useOverlayDismiss(overlayRef, backdropRef, handleClose)

  useEffect(() => {
    if (!open) return
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) handleClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, handleClose, saving])

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : ''
    return () => {
      document.body.style.overflow = ''
    }
  }, [open])

  useEffect(() => {
    if (!open) {
      reset()
      return
    }
    if (initialPlatform) {
      setRows(prev => prev.map(row => ({ ...row, platform: initialPlatform })))
    }
  }, [open, reset, initialPlatform])

  useEffect(() => {
    if (!saving) return
    connectStartedAtRef.current = Date.now()
    setConnectStep(0)
    const timer = window.setInterval(() => {
      const elapsed = Date.now() - connectStartedAtRef.current
      if (elapsed >= 45_000) setConnectStep(2)
      else if (elapsed >= 12_000) setConnectStep(1)
      else setConnectStep(0)
    }, 1_000)
    return () => window.clearInterval(timer)
  }, [saving])

  const setRowField = useCallback((
    index: number,
    field: keyof ConnectTradingAccountForm,
    value: string,
  ) => {
    setRows(prev => prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)))
  }, [])

  const addRow = useCallback(() => {
    setRows(prev => [...prev, {
      ...emptyConnectTradingAccountForm,
      platform: prev[0]?.platform ?? 'MT5',
    }])
  }, [])

  const removeRow = useCallback((index: number) => {
    setRows(prev => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)))
  }, [])

  const activeBrokerCount = resolveActiveBrokerCount(brokers, usage.brokerAccounts)

  const setPlatform = useCallback((platform: TradingPlatform) => {
    setRows(prev => prev.map(row => ({ ...row, platform })))
  }, [])

  const startCtrader = async () => {
    setError('')
    if (!hasActiveSubscription) {
      setError(pw.subscriptionRequired)
      return
    }
    if (!isAdmin && activeBrokerCount >= limits.maxBrokerAccounts) {
      setError(interpolate(pw.brokerLimit, { limit: String(limits.maxBrokerAccounts) }))
      return
    }
    setSaving(true)
    try {
      const { authorizeUrl } = await startCtraderConnect()
      window.location.assign(authorizeUrl)
    } catch (err) {
      const message = err instanceof Error ? err.message : cf.ctraderNotConfigured
      setError(message)
      setSaving(false)
    }
  }

  const startBinance = async () => {
    setError('')
    setBinanceFieldError(null)
    if (!hasActiveSubscription) {
      setError(pw.subscriptionRequired)
      return
    }
    if (!isAdmin && activeBrokerCount >= limits.maxBrokerAccounts) {
      setError(interpolate(pw.brokerLimit, { limit: String(limits.maxBrokerAccounts) }))
      return
    }
    if (!binanceKey.trim() || !binanceSecret.trim()) {
      setError(cf.binanceKeysRequired)
      return
    }
    const parsed = parseBinanceSettingsDraft(binanceDraft)
    if (!parsed.ok) {
      setBinanceFieldError(parsed.field === 'margin' ? 'margin' : parsed.field === 'leverage' ? 'leverage' : null)
      return
    }
    setSaving(true)
    try {
      const { account } = await linkBinanceAccount({
        apiKey: binanceKey,
        apiSecret: binanceSecret,
        environment: binanceEnv,
        label: binanceLabel,
        settings: parsed.settings,
      })
      upsertBroker(account)
      reset()
      if (onSuccess) onSuccess(account)
      else onClose()
    } catch (err) {
      const message = err instanceof Error ? err.message : cf.connectFailed
      setError(message || cf.connectFailed)
      setSaving(false)
    }
  }

  const startBybit = async () => {
    setError('')
    setBybitFieldError(null)
    if (!hasActiveSubscription) {
      setError(pw.subscriptionRequired)
      return
    }
    if (!isAdmin && activeBrokerCount >= limits.maxBrokerAccounts) {
      setError(interpolate(pw.brokerLimit, { limit: String(limits.maxBrokerAccounts) }))
      return
    }
    if (!bybitKey.trim() || !bybitSecret.trim()) {
      setError(cf.binanceKeysRequired)
      return
    }
    const parsed = parseBybitSettingsDraft(bybitDraft)
    if (!parsed.ok) {
      setBybitFieldError(parsed.field)
      return
    }
    setSaving(true)
    try {
      const { account } = await linkBybitAccount({
        apiKey: bybitKey,
        apiSecret: bybitSecret,
        environment: bybitEnv,
        label: bybitLabel,
        settings: parsed.settings,
      })
      upsertBroker(account)
      reset()
      if (onSuccess) onSuccess(account)
      else onClose()
    } catch (err) {
      const message = err instanceof Error ? err.message : cf.connectFailed
      setError(message || cf.connectFailed)
      setSaving(false)
    }
  }

  const startKucoin = async () => {
    setError('')
    setKucoinFieldError(null)
    if (!hasActiveSubscription) {
      setError(pw.subscriptionRequired)
      return
    }
    if (!isAdmin && activeBrokerCount >= limits.maxBrokerAccounts) {
      setError(interpolate(pw.brokerLimit, { limit: String(limits.maxBrokerAccounts) }))
      return
    }
    if (!kucoinKey.trim() || !kucoinSecret.trim() || !kucoinPassphrase.trim()) {
      setError(cf.kucoinKeysRequired)
      return
    }
    const parsed = parseKucoinSettingsDraft(kucoinDraft)
    if (!parsed.ok) {
      setKucoinFieldError(parsed.field === 'margin' || parsed.field === 'leverage' ? parsed.field : null)
      return
    }
    setSaving(true)
    try {
      const { account } = await linkKucoinAccount({
        apiKey: kucoinKey,
        apiSecret: kucoinSecret,
        passphrase: kucoinPassphrase,
        label: kucoinLabel,
        settings: parsed.settings,
      })
      upsertBroker(account)
      reset()
      if (onSuccess) onSuccess(account)
      else onClose()
    } catch (err) {
      const message = err instanceof Error ? err.message : cf.connectFailed
      setError(message || cf.connectFailed)
      setSaving(false)
    }
  }

  const startDxtrade = async () => {
    setError('')
    setDxtradeFieldError(null)
    if (!hasActiveSubscription) {
      setError(pw.subscriptionRequired)
      return
    }
    if (!isAdmin && activeBrokerCount >= limits.maxBrokerAccounts) {
      setError(interpolate(pw.brokerLimit, { limit: String(limits.maxBrokerAccounts) }))
      return
    }
    const parsed = parseDxtradeDraft(dxtradeDraft)
    if (!parsed.ok) {
      setDxtradeFieldError(parsed.field)
      if (parsed.field === 'password') setError(cf.dxtradeLoginRequired)
      return
    }
    setSaving(true)
    try {
      const { account } = await linkDxtradeAccount(parsed.login)
      upsertBroker(account)
      reset()
      if (onSuccess) onSuccess(account)
      else onClose()
    } catch (err) {
      const message = err instanceof Error ? err.message : cf.connectFailed
      setError(message || cf.connectFailed)
      setSaving(false)
    }
  }

  const connectSingle = async (row: ConnectTradingAccountForm) => {
    if (row.platform === 'cTrader' || row.platform === 'Binance' || row.platform === 'Bybit' || row.platform === 'KuCoin' || row.platform === 'DXtrade') return
    const login = row.account_number.trim()
    const server = row.broker_server.trim()
    const platform = row.platform
    const { account } = await fxsocketBroker.connect({
      login,
      password: row.account_password,
      server,
      platform,
      label: row.label.trim() || undefined,
      provider: 'mtapi',
    })
    upsertBroker(account)

    let ready = account
    if (account.connection_status !== 'connected') {
      const result = await fxsocketBroker.waitUntilConnected(account.id, {
        provider: 'mtapi',
        onProgress: ({ account: updated }) => upsertBroker(updated),
      })
      ready = result.account
      upsertBroker(ready)
    }
    return ready
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (rows[0]?.platform === 'cTrader') {
      await startCtrader()
      return
    }
    if (rows[0]?.platform === 'Binance') {
      await startBinance()
      return
    }
    if (rows[0]?.platform === 'Bybit') {
      await startBybit()
      return
    }
    if (rows[0]?.platform === 'KuCoin') {
      await startKucoin()
      return
    }
    if (rows[0]?.platform === 'DXtrade') {
      await startDxtrade()
      return
    }
    setError('')

    if (!hasActiveSubscription) {
      setError(pw.subscriptionRequired)
      return
    }
    if (!isAdmin && activeBrokerCount >= limits.maxBrokerAccounts) {
      setError(interpolate(pw.brokerLimit, { limit: String(limits.maxBrokerAccounts) }))
      return
    }

    const validRows = rows.filter(row => validateConnectRow(row) == null)
    if (validRows.length === 0) {
      setError(cf.validationRequired)
      return
    }

    if (validRows.length === 1 && rows.length === 1) {
      const row = validRows[0]!
      const login = row.account_number.trim()
      const server = row.broker_server.trim()
      const duplicate = brokers.find(b => b.account_login === login && b.broker_server === server)
      if (duplicate) {
        setError(t.accountConfig.brokerList.duplicateMtLogin)
        return
      }

      setSaving(true)
      try {
        const ready = await connectSingle(row)
        reset()
        if (ready && onSuccess) onSuccess(ready)
        else onClose()
      } catch (err) {
        const message = err instanceof Error ? err.message : cf.connectFailed
        setError(userFacingBrokerConnectError(message, connectErrorLabels, { credentialConnect: true }) || cf.connectFailed)
        setSaving(false)
      }
      return
    }

    setSaving(true)

    try {
      const result = await connectAccountsBatch({
        rows: validRows,
        existingBrokers: brokers,
        activeBrokerCountAtStart: activeBrokerCount,
        maxBrokerAccounts: isAdmin ? null : limits.maxBrokerAccounts,
        getKnownBrokers: () => brokersRef.current,
        onProgress: progress => {
          setBatchRows(progress)
          for (const entry of progress) {
            if (entry.status === 'linked' && entry.account) upsertBroker(entry.account)
          }
        },
      })

      reset()
      onClose()
      onBatchSuccess?.(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : cf.connectFailed
      setError(userFacingBrokerConnectError(message, connectErrorLabels, { credentialConnect: true }) || cf.connectFailed)
      setSaving(false)
    }
  }

  if (!open) return null

  const selectedPlatform = rows[0]?.platform ?? 'MT5'
  const binanceSelected = selectedPlatform === 'Binance'
  const bybitSelected = selectedPlatform === 'Bybit'
  const kucoinSelected = selectedPlatform === 'KuCoin'
  const dxtradeSelected = selectedPlatform === 'DXtrade'
  const ctraderSelected = selectedPlatform === 'cTrader'
  const mtFormHidden = ctraderSelected || binanceSelected || bybitSelected || kucoinSelected || dxtradeSelected
  const title = interpolate(cf.title, { platform: selectedPlatform })
  const validCount = countValidRows(rows)
  const isMulti = rows.length > 1 || validCount > 1
  const serverPlatformMismatch = rows
    .map(row => {
      const inferred = inferServerPlatform(row.broker_server)
      return inferred && inferred !== row.platform ? inferred : null
    })
    .find(Boolean) ?? null
  const connectStepMessage = connectStep === 2
    ? cf.connectingStepSlow
    : connectStep === 1
      ? interpolate(cf.connectingStepTerminal, { platform: selectedPlatform })
      : interpolate(cf.connectingStepLinking, { platform: selectedPlatform })
  const submitLabel = isMulti
    ? interpolate(cf.connectMultipleButton, { count: String(validCount) })
    : cf.connectButton

  return (
    <>
      <div
        ref={overlayRef}
        className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8"
        onMouseDown={onOverlayMouseDown}
        onClick={onOverlayClick}
      >
        <div ref={backdropRef} className="absolute inset-0 bg-neutral-950/55 animate-in" aria-hidden />

        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="connect-trading-account-title"
          className="relative flex max-h-[min(92dvh,56rem)] w-full max-w-2xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl animate-modal-in dark:bg-neutral-900"
        >
          <div className="shrink-0 px-6 pb-4 pt-6 sm:px-8 sm:pt-8">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2
                  id="connect-trading-account-title"
                  className="text-lg font-semibold text-neutral-900 dark:text-neutral-50"
                >
                  {title}
                </h2>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {mtFormHidden ? null : (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setBulkUploadOpen(true)}
                    disabled={saving}
                  >
                    {cf.uploadAccountsButton}
                  </Button>
                )}
                <button
                  type="button"
                  onClick={handleClose}
                  disabled={saving}
                  aria-label={t.common.cancel}
                  className="rounded-xl p-3 text-neutral-900 dark:text-neutral-50 transition-colors hover:bg-neutral-100 hover:text-neutral-900 disabled:opacity-40 dark:hover:bg-neutral-800 dark:hover:text-neutral-50"
                >
                  <X className="h-6 w-6" />
                </button>
              </div>
            </div>
          </div>

          <div className="mx-6 h-px bg-neutral-100 dark:bg-neutral-800 sm:mx-8" />

          <div className="relative min-h-0 flex-1 overflow-y-auto p-6 sm:p-8">
            {error ? <PaywallErrorAlert message={error} className="mb-4" /> : null}

            <form onSubmit={handleSubmit} className={clsx('space-y-4', saving && 'pointer-events-none opacity-60')}>
              {ctraderSelected ? (
                <div className="space-y-4 rounded-2xl border border-neutral-100 p-4 dark:border-neutral-800">
                  <p className="text-sm text-neutral-900 dark:text-neutral-50">{cf.ctraderConnectHint}</p>
                  <div className="flex gap-2">
                    <Button type="button" size="sm" loading={saving} onClick={() => void startCtrader()}>
                      {cf.ctraderConnectButton}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={handleClose} disabled={saving}>
                      {t.common.cancel}
                    </Button>
                  </div>
                </div>
              ) : null}

              {binanceSelected ? (
                <div className="space-y-4 rounded-2xl border border-neutral-100 p-4 dark:border-neutral-800">
                  <p className="text-sm text-neutral-900 dark:text-neutral-50">{cf.binanceConnectHint}</p>
                  <Input
                    label={cf.accountLabel}
                    placeholder={interpolate(cf.accountLabelPlaceholder, { platform: 'Binance' })}
                    value={binanceLabel}
                    onChange={event => setBinanceLabel(event.target.value)}
                  />
                  <Input
                    label={cf.binanceApiKeyLabel}
                    labelAddon={
                      <ApiKeyHelp
                        title={cf.binanceApiHelpTitle}
                        steps={cf.binanceApiHelpSteps}
                        linkLabel={cf.binanceApiHelpLink}
                        href={BINANCE_API_MANAGEMENT_URL}
                      />
                    }
                    value={binanceKey}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={event => setBinanceKey(event.target.value)}
                    required
                  />
                  <PasswordInput
                    label={cf.binanceApiSecretLabel}
                    value={binanceSecret}
                    hint={cf.binanceApiSecretHint}
                    onChange={event => setBinanceSecret(event.target.value)}
                    required
                  />
                  <div className="space-y-1.5">
                    <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50">{cf.binanceEnvironmentLabel}</p>
                    <div className="grid grid-cols-2 gap-2">
                      {(['live', 'demo'] as const).map(env => (
                        <button
                          key={env}
                          type="button"
                          aria-pressed={binanceEnv === env}
                          onClick={() => setBinanceEnv(env)}
                          className={clsx(
                            'rounded-xl border px-3 py-2 text-left text-sm transition-colors',
                            binanceEnv === env
                              ? 'border-green-400 bg-teal-50 text-teal-900 dark:border-green-400 dark:bg-teal-950/40 dark:text-teal-100'
                              : 'border-neutral-200/65 bg-white text-neutral-900 hover:border-neutral-300 dark:border-neutral-800/55 dark:bg-neutral-900 dark:text-neutral-50 dark:hover:border-neutral-700',
                          )}
                        >
                          {env === 'live' ? cf.binanceLive : cf.binanceDemo}
                        </button>
                      ))}
                    </div>
                  </div>
                  <BinanceSettingsFields
                    value={binanceDraft}
                    onChange={setBinanceDraft}
                    marginError={binanceFieldError === 'margin' ? cf.binanceInvalidMargin : undefined}
                    leverageError={binanceFieldError === 'leverage' ? cf.binanceInvalidLeverage : undefined}
                  />
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" loading={saving}>
                      {cf.binanceConnectButton}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={handleClose} disabled={saving}>
                      {t.common.cancel}
                    </Button>
                  </div>
                </div>
              ) : null}

              {bybitSelected ? (
                <div className="space-y-4 rounded-2xl border border-neutral-100 p-4 dark:border-neutral-800">
                  <p className="text-sm text-neutral-900 dark:text-neutral-50">{cf.bybitConnectHint}</p>
                  <Input
                    label={cf.accountLabel}
                    placeholder={interpolate(cf.accountLabelPlaceholder, { platform: 'Bybit' })}
                    value={bybitLabel}
                    onChange={event => setBybitLabel(event.target.value)}
                  />
                  <Input
                    label={cf.binanceApiKeyLabel}
                    labelAddon={
                      <ApiKeyHelp
                        title={cf.binanceApiHelpTitle}
                        steps={cf.bybitApiHelpSteps}
                        linkLabel={cf.bybitApiHelpLink}
                        href={BYBIT_API_MANAGEMENT_URL}
                      />
                    }
                    value={bybitKey}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={event => setBybitKey(event.target.value)}
                    required
                  />
                  <PasswordInput
                    label={cf.binanceApiSecretLabel}
                    value={bybitSecret}
                    hint={cf.binanceApiSecretHint}
                    onChange={event => setBybitSecret(event.target.value)}
                    required
                  />
                  <div className="space-y-1.5">
                    <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50">{cf.binanceEnvironmentLabel}</p>
                    <div className="grid grid-cols-2 gap-2">
                      {(['live', 'demo'] as const).map(env => (
                        <button
                          key={env}
                          type="button"
                          aria-pressed={bybitEnv === env}
                          onClick={() => setBybitEnv(env)}
                          className={clsx(
                            'rounded-xl border px-3 py-2 text-left text-sm transition-colors',
                            bybitEnv === env
                              ? 'border-green-400 bg-teal-50 text-teal-900 dark:border-green-400 dark:bg-teal-950/40 dark:text-teal-100'
                              : 'border-neutral-200/65 bg-white text-neutral-900 hover:border-neutral-300 dark:border-neutral-800/55 dark:bg-neutral-900 dark:text-neutral-50 dark:hover:border-neutral-700',
                          )}
                        >
                          {env === 'live' ? cf.binanceLive : cf.binanceDemo}
                        </button>
                      ))}
                    </div>
                  </div>
                  <BinanceSettingsFields
                    value={bybitDraft}
                    onChange={setBybitDraft}
                    marginError={bybitFieldError === 'margin' ? cf.binanceInvalidMargin : undefined}
                    leverageError={bybitFieldError === 'leverage' ? cf.binanceInvalidLeverage : undefined}
                    showMarginMode={false}
                  />
                  <p className="text-xs text-neutral-900 dark:text-neutral-50">{cf.bybitMarginModeNote}</p>
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" loading={saving}>
                      {cf.bybitConnectButton}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={handleClose} disabled={saving}>
                      {t.common.cancel}
                    </Button>
                  </div>
                </div>
              ) : null}

              {kucoinSelected ? (
                <div className="space-y-4 rounded-2xl border border-neutral-100 p-4 dark:border-neutral-800">
                  <p className="text-sm text-neutral-900 dark:text-neutral-50">{cf.kucoinConnectHint}</p>
                  <Input
                    label={cf.accountLabel}
                    placeholder={interpolate(cf.accountLabelPlaceholder, { platform: 'KuCoin' })}
                    value={kucoinLabel}
                    onChange={event => setKucoinLabel(event.target.value)}
                  />
                  <Input
                    label={cf.binanceApiKeyLabel}
                    labelAddon={
                      <ApiKeyHelp
                        title={cf.binanceApiHelpTitle}
                        steps={cf.kucoinApiHelpSteps}
                        linkLabel={cf.kucoinApiHelpLink}
                        href={KUCOIN_API_MANAGEMENT_URL}
                      />
                    }
                    value={kucoinKey}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={event => setKucoinKey(event.target.value)}
                    required
                  />
                  <PasswordInput
                    label={cf.binanceApiSecretLabel}
                    value={kucoinSecret}
                    hint={cf.binanceApiSecretHint}
                    onChange={event => setKucoinSecret(event.target.value)}
                    required
                  />
                  <PasswordInput
                    label={cf.kucoinApiPassphraseLabel}
                    value={kucoinPassphrase}
                    hint={cf.kucoinApiPassphraseHint}
                    onChange={event => setKucoinPassphrase(event.target.value)}
                    required
                  />
                  <BinanceSettingsFields
                    value={kucoinDraft}
                    onChange={setKucoinDraft}
                    marginError={kucoinFieldError === 'margin' ? cf.binanceInvalidMargin : undefined}
                    leverageError={kucoinFieldError === 'leverage' ? cf.binanceInvalidLeverage : undefined}
                  />
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" loading={saving}>
                      {cf.kucoinConnectButton}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={handleClose} disabled={saving}>
                      {t.common.cancel}
                    </Button>
                  </div>
                </div>
              ) : null}

              {dxtradeSelected ? (
                <div className="space-y-4 rounded-2xl border border-neutral-100 p-4 dark:border-neutral-800">
                  <p className="text-sm text-neutral-900 dark:text-neutral-50">{cf.dxtradeConnectHint}</p>
                  <Input
                    label={cf.accountLabel}
                    placeholder={interpolate(cf.accountLabelPlaceholder, { platform: 'DXtrade' })}
                    value={dxtradeDraft.label}
                    onChange={event => setDxtradeDraft(prev => ({ ...prev, label: event.target.value }))}
                  />
                  <Input
                    label={cf.dxtradeServerUrlLabel}
                    placeholder="https://trade.your-broker.com"
                    value={dxtradeDraft.serverUrl}
                    hint={cf.dxtradeServerUrlHint}
                    error={dxtradeFieldError === 'server' ? cf.dxtradeInvalidServer : undefined}
                    autoComplete="off"
                    spellCheck={false}
                    inputMode="url"
                    onChange={event => setDxtradeDraft(prev => ({ ...prev, serverUrl: event.target.value }))}
                    required
                  />
                  <Input
                    label={cf.dxtradeUsernameLabel}
                    value={dxtradeDraft.username}
                    error={dxtradeFieldError === 'username' ? cf.dxtradeInvalidUsername : undefined}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={event => setDxtradeDraft(prev => ({ ...prev, username: event.target.value }))}
                    required
                  />
                  <Input
                    label={cf.dxtradeDomainLabel}
                    value={dxtradeDraft.domain}
                    hint={cf.dxtradeDomainHint}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={event => setDxtradeDraft(prev => ({ ...prev, domain: event.target.value }))}
                  />
                  <PasswordInput
                    label={cf.dxtradePasswordLabel}
                    value={dxtradeDraft.password}
                    hint={cf.dxtradePasswordHint}
                    onChange={event => setDxtradeDraft(prev => ({ ...prev, password: event.target.value }))}
                    required
                  />
                  <Input
                    label={cf.dxtradeAccountCodeLabel}
                    value={dxtradeDraft.accountCode}
                    hint={cf.dxtradeAccountCodeHint}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={event => setDxtradeDraft(prev => ({ ...prev, accountCode: event.target.value }))}
                  />
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" loading={saving}>
                      {cf.dxtradeConnectButton}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={handleClose} disabled={saving}>
                      {t.common.cancel}
                    </Button>
                  </div>
                </div>
              ) : null}

              {serverPlatformMismatch && !mtFormHidden ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100">
                  <p>
                    {serverPlatformMismatch === 'MT4'
                      ? t.accountConfig.brokerList.platformServerMismatchMt4
                      : t.accountConfig.brokerList.platformServerMismatchMt5}
                  </p>
                  <button
                    type="button"
                    onClick={() => setPlatform(serverPlatformMismatch)}
                    className="mt-2 font-medium text-green-500 underline underline-offset-2 hover:text-teal-800 dark:text-teal-300 dark:hover:text-teal-200"
                  >
                    {serverPlatformMismatch === 'MT4' ? cf.platformMt4 : cf.platformMt5}
                  </button>
                </div>
              ) : null}

              {mtFormHidden ? null : rows.map((row, index) => (
                <div
                  key={index}
                  className="space-y-3 rounded-2xl border border-neutral-100 p-4 dark:border-neutral-800"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50">
                      {interpolate(cf.accountRowTitle, { index: String(index + 1) })}
                    </p>
                    {rows.length > 1 ? (
                      <button
                        type="button"
                        onClick={() => removeRow(index)}
                        aria-label={cf.removeRowAria}
                        className="rounded-lg p-1.5 text-neutral-900 dark:text-neutral-50 transition-colors hover:bg-neutral-100 hover:text-error-600 dark:hover:bg-neutral-800"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    ) : null}
                  </div>

                  <Input
                    label={cf.accountLabel}
                    placeholder={interpolate(cf.accountLabelPlaceholder, { platform: selectedPlatform })}
                    value={row.label}
                    onChange={event => setRowField(index, 'label', event.target.value)}
                  />

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Input
                      label={cf.mtLoginLabel}
                      placeholder={cf.mtLoginPlaceholder}
                      value={row.account_number}
                      onChange={event => setRowField(index, 'account_number', event.target.value)}
                      required
                    />
                    <PasswordInput
                      label={cf.passwordLabel}
                      placeholder={cf.passwordPlaceholder}
                      value={row.account_password}
                      onChange={event => setRowField(index, 'account_password', event.target.value)}
                      hint={cf.passwordHint}
                      required
                    />
                  </div>

                  <MtCompanyServerPicker
                    value={row.broker_server}
                    onChange={next => setRowField(index, 'broker_server', next)}
                    platform={selectedPlatform === 'MT4' ? 'MT4' : 'MT5'}
                    hint={index === 0 ? cf.brokerServerHint : undefined}
                    required
                  />
                </div>
              ))}

              {mtFormHidden ? null : (
                <>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="secondary" size="sm" onClick={addRow} disabled={saving}>
                      <Plus className="mr-1.5 h-4 w-4" />
                      {cf.addMoreButton}
                    </Button>
                  </div>

                  <div className="flex gap-2 pt-2">
                    <Button type="submit" loading={saving} size="sm" disabled={validCount === 0}>
                      {submitLabel}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={handleClose} disabled={saving}>
                      {t.common.cancel}
                    </Button>
                  </div>
                </>
              )}
            </form>

            {saving && batchRows.length > 0 ? (
              <ConnectAccountsBatchProgress title={bc.connectingTitle} rows={batchRows} copy={bc} />
            ) : null}

            {saving && batchRows.length === 0 ? (
              <div
                className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-white/90 px-8 text-center dark:bg-neutral-900/90"
                role="status"
                aria-live="polite"
              >
                <Loader2 className="h-10 w-10 animate-spin text-green-400 dark:text-green-400" />
                <div>
                  <p className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
                    {cf.connectingTitle}
                  </p>
                  <p className="mt-2 text-sm text-neutral-900 dark:text-neutral-50">
                    {connectStepMessage}
                  </p>
                </div>
              </div>
            ) : null}
          </div>

          {onChangePlatform ? (
            <div className="flex shrink-0 justify-end border-t border-neutral-100 px-6 py-4 dark:border-neutral-800 sm:px-8">
              <Button type="button" variant="secondary" size="sm" onClick={onChangePlatform} disabled={saving}>
                {cf.selectAnotherPlatform}
              </Button>
            </div>
          ) : null}
        </div>
      </div>

      <BulkUploadAccountsModal
        open={bulkUploadOpen}
        onClose={() => setBulkUploadOpen(false)}
        onBatchComplete={result => {
          setBulkUploadOpen(false)
          handleClose()
          onBatchSuccess?.(result)
        }}
      />
    </>
  )
}

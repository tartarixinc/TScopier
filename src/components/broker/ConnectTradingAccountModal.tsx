import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { X } from 'lucide-react'
import { useT } from '../../context/LocaleContext'
import { interpolate } from '../../i18n/interpolate'
import { useBrokerAccounts } from '../../context/BrokerAccountsContext'
import { useSubscription } from '../../context/SubscriptionContext'
import { metatraderApi } from '../../lib/metatraderapi'
import {
  emptyConnectTradingAccountForm,
  type ConnectTradingAccountForm,
} from '../../lib/connectTradingAccountForm'
import { tailRefreshBrokerSummary } from '../../lib/tailRefreshBrokerSummary'
import { PaywallErrorAlert } from '../billing/PaywallErrorAlert'
import { PasswordInput } from '../auth/PasswordInput'
import { Input } from '../ui/Input'
import { Select } from '../ui/Select'
import { Button } from '../ui/Button'
import { MtCompanyServerPicker } from '../ui/MtCompanyServerPicker'
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss'

type ConnectTradingAccountModalProps = {
  open: boolean
  onClose: () => void
}

export function ConnectTradingAccountModal({ open, onClose }: ConnectTradingAccountModalProps) {
  const t = useT()
  const bl = t.accountConfig.brokerList
  const pw = t.pricing.paywall
  const { brokers, upsertBroker, patchBroker } = useBrokerAccounts()
  const { hasActiveSubscription, canAddBroker, limits } = useSubscription()
  const overlayRef = useRef<HTMLDivElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)

  const [form, setForm] = useState<ConnectTradingAccountForm>(emptyConnectTradingAccountForm)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const reset = useCallback(() => {
    setForm(emptyConnectTradingAccountForm)
    setError('')
    setSaving(false)
  }, [])

  const handleClose = useCallback(() => {
    reset()
    onClose()
  }, [onClose, reset])

  const { onOverlayMouseDown, onOverlayClick } = useOverlayDismiss(overlayRef, backdropRef, handleClose)

  useEffect(() => {
    if (!open) return
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handleClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open, handleClose])

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : ''
    return () => {
      document.body.style.overflow = ''
    }
  }, [open])

  useEffect(() => {
    if (!open) reset()
  }, [open, reset])

  const setField = (field: keyof ConnectTradingAccountForm, value: string | boolean) => {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')

    if (!hasActiveSubscription) {
      setError(pw.subscriptionRequired)
      return
    }
    if (!canAddBroker()) {
      setError(interpolate(pw.brokerLimit, { limit: String(limits.maxBrokerAccounts) }))
      return
    }
    if (!form.account_number.trim() || !form.broker_server.trim() || !form.account_password) {
      setError(t.accountConfig.connectForm.validationRequired)
      return
    }

    setSaving(true)
    const login = form.account_number.trim()
    const server = form.broker_server.trim()
    const duplicate = brokers.find(b => b.account_login === login && b.broker_server === server)
    if (duplicate) {
      setError(bl.duplicateMtLogin)
      setSaving(false)
      return
    }

    const serverUpper = server.toUpperCase()
    const serverSuggestsMt4 = /MT4|METATRADER\s*4/.test(serverUpper) && !/MT5/.test(serverUpper)
    const serverSuggestsMt5 = /MT5|METATRADER\s*5/.test(serverUpper) && !/MT4/.test(serverUpper)
    if (form.platform === 'MT5' && serverSuggestsMt4) {
      const proceed = window.confirm(bl.platformServerMismatchMt4)
      if (!proceed) {
        setSaving(false)
        return
      }
    }
    if (form.platform === 'MT4' && serverSuggestsMt5) {
      const proceed = window.confirm(bl.platformServerMismatchMt5)
      if (!proceed) {
        setSaving(false)
        return
      }
    }

    try {
      const { broker } = await metatraderApi.register({
        platform: form.platform,
        server,
        login,
        password: form.account_password,
        label: form.label.trim() || undefined,
      })
      upsertBroker(broker)
      if (broker?.id && broker.last_balance == null && broker.last_equity == null) {
        void tailRefreshBrokerSummary(broker.id, [...brokers, broker], patch => {
          patchBroker(broker.id, patch)
        })
      }
      handleClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t.accountConfig.connectForm.connectFailed)
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null

  const title = interpolate(t.accountConfig.connectForm.title, { platform: form.platform })

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8"
      onMouseDown={onOverlayMouseDown}
      onClick={onOverlayClick}
    >
      <div ref={backdropRef} className="absolute inset-0 bg-neutral-950/40 backdrop-blur-sm animate-in" />

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
            <button
              type="button"
              onClick={handleClose}
              aria-label={t.common.cancel}
              className="shrink-0 rounded-xl p-3 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            >
              <X className="h-6 w-6" />
            </button>
          </div>
        </div>

        <div className="mx-6 h-px bg-neutral-100 dark:bg-neutral-800 sm:mx-8" />

        <div className="min-h-0 flex-1 overflow-y-auto p-6 sm:p-8">
          {error ? <PaywallErrorAlert message={error} className="mb-4" /> : null}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Input
                label={t.accountConfig.connectForm.accountLabel}
                placeholder={interpolate(t.accountConfig.connectForm.accountLabelPlaceholder, {
                  platform: form.platform,
                })}
                value={form.label}
                onChange={event => setField('label', event.target.value)}
              />
              <Select
                label={t.accountConfig.connectForm.platformLabel}
                value={form.platform}
                onChange={event => setField('platform', event.target.value)}
                options={[
                  { value: 'MT5', label: t.accountConfig.connectForm.platformMt5 },
                  { value: 'MT4', label: t.accountConfig.connectForm.platformMt4 },
                ]}
              />
            </div>

            <MtCompanyServerPicker
              platform={form.platform}
              value={form.broker_server}
              onChange={value => setField('broker_server', value)}
              hint={t.accountConfig.connectForm.brokerServerHint}
              required
            />

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Input
                label={t.accountConfig.connectForm.mtLoginLabel}
                placeholder={t.accountConfig.connectForm.mtLoginPlaceholder}
                value={form.account_number}
                onChange={event => setField('account_number', event.target.value)}
                required
              />
              <PasswordInput
                label={t.accountConfig.connectForm.passwordLabel}
                placeholder={t.accountConfig.connectForm.passwordPlaceholder}
                value={form.account_password}
                onChange={event => setField('account_password', event.target.value)}
                hint={t.accountConfig.connectForm.passwordHint}
                required
              />
            </div>

            <div className="flex gap-2 pt-2">
              <Button type="submit" loading={saving} size="sm">
                {t.accountConfig.connectForm.connectButton}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={handleClose}>
                {t.common.cancel}
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}

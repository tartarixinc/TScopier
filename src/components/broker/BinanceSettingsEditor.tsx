import { useEffect, useState } from 'react'
import { useT } from '../../context/LocaleContext'
import {
  binanceSettingsDraftFromBroker,
  parseBinanceSettingsDraft,
  updateBinanceSettings,
  type BinanceSettingsDraft,
} from '../../lib/binanceBroker'
import type { BrokerAccount } from '../../types/database'
import { Button } from '../ui/Button'
import { BinanceSettingsFields } from './BinanceSettingsFields'

type BinanceSettingsEditorProps = {
  broker: BrokerAccount
  onSaved: (account: BrokerAccount) => void
}

/** Margin, leverage and margin mode stay editable after the account is linked. */
export function BinanceSettingsEditor({ broker, onSaved }: BinanceSettingsEditorProps) {
  const cf = useT().accountConfig.connectForm
  const [draft, setDraft] = useState<BinanceSettingsDraft>(() => binanceSettingsDraftFromBroker(broker))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [fieldError, setFieldError] = useState<'margin' | 'leverage' | null>(null)

  useEffect(() => {
    setDraft(binanceSettingsDraftFromBroker(broker))
  }, [broker.id, broker.binance_margin_usdt, broker.binance_leverage, broker.binance_margin_mode])

  const save = async () => {
    setError('')
    setSaved(false)
    setFieldError(null)
    const parsed = parseBinanceSettingsDraft(draft)
    if (!parsed.ok) {
      setFieldError(parsed.field === 'margin' ? 'margin' : parsed.field === 'leverage' ? 'leverage' : null)
      return
    }
    setSaving(true)
    try {
      const account = await updateBinanceSettings(broker.id, parsed.settings)
      onSaved(account)
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : cf.connectFailed)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="space-y-3 rounded-xl border border-neutral-200/65 bg-neutral-50/80 p-4 dark:border-neutral-800/55 dark:bg-neutral-800/40">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-900 dark:text-neutral-50">
        {cf.binanceSettingsTitle}
      </h3>
      <BinanceSettingsFields
        value={draft}
        onChange={next => {
          setDraft(next)
          setSaved(false)
        }}
        marginError={fieldError === 'margin' ? cf.binanceInvalidMargin : undefined}
        leverageError={fieldError === 'leverage' ? cf.binanceInvalidLeverage : undefined}
        disabled={saving}
      />
      {error ? <p className="text-xs text-error-600 dark:text-error-400">{error}</p> : null}
      {saved ? <p className="text-xs text-green-500 dark:text-green-400">{cf.binanceSettingsSaved}</p> : null}
      <Button type="button" size="sm" loading={saving} onClick={() => void save()}>
        {cf.binanceSettingsSave}
      </Button>
    </section>
  )
}

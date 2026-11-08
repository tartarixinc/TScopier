import { useState } from 'react'
import { SlaveConfigureModal } from '../configure/SlaveConfigureModal'
import { useBrokerAccounts } from '../../context/BrokerAccountsContext'
import { useT } from '../../context/LocaleContext'
import { interpolate } from '../../i18n/interpolate'
import {
  socialSizingColumnsFromCopyRisk,
  updateSocialCopySubscriptionSettings,
  type MySocialCopySubscription,
} from '../../lib/socialCopy'
import { copyRiskLabelsForSocial, socialCopySetupToMirrorSetup } from '../../lib/socialCopySetupLabels'
import type { SocialTrader } from '../../lib/socialTradingFixture'
import type { SocialTradingPageTranslations } from '../../i18n/locales/types'
import type { CopyRiskSettings } from '../../lib/copyRiskTypes'
import { supabase } from '../../lib/supabase'

export function ConfigureCopyModal({
  trader,
  subscription,
  copy,
  onClose,
  onSaved,
}: {
  trader: SocialTrader
  subscription: MySocialCopySubscription
  copy: SocialTradingPageTranslations
  onClose: () => void
  onSaved?: () => void
}) {
  const c = copy.copySetup
  const t = useT()
  const { brokers } = useBrokerAccounts()
  const destination = brokers.find(broker => broker.id === subscription.destinationBrokerAccountId) ?? null

  const [settings, setSettings] = useState<CopyRiskSettings>(() => subscription.copyRisk)
  const [symbolMap, setSymbolMap] = useState<Record<string, string>>(() => ({ ...subscription.symbolMap }))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const saveSettings = async () => {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const sizing = socialSizingColumnsFromCopyRisk(settings)
      await updateSocialCopySubscriptionSettings(supabase, {
        subscriptionId: subscription.id,
        sizingMode: sizing.sizingMode,
        fixedLot: sizing.fixedLot,
        lotMultiplier: sizing.lotMultiplier,
        maxLot: sizing.maxLot,
        manualSettings: subscription.manualSettings,
        copyRisk: settings,
        symbolMap,
      })
      onSaved?.()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to save copy settings.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <SlaveConfigureModal
      slave={destination}
      source={null}
      settings={settings}
      labels={copyRiskLabelsForSocial(t.copyRisk)}
      setup={socialCopySetupToMirrorSetup(c)}
      loginLabel={c.login}
      balanceLabel={c.balance}
      saveError={error}
      closeLabel={c.close}
      symbolMap={symbolMap}
      onSymbolMapChange={setSymbolMap}
      onChange={setSettings}
      onClose={onClose}
      title={interpolate(c.configureTitle ?? 'Configure copy · {trader}', { trader: trader.displayName })}
      sourceName={`@${trader.username}`}
      primaryLabel={c.saveSettings ?? 'Save settings'}
      onPrimary={saveSettings}
      primaryLoading={submitting}
      primaryDisabled={submitting || !destination}
    />
  )
}

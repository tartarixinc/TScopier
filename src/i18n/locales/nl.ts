import { authNl } from '../auth/nl'
import { channelWorkerNl } from '../channelWorker/nl'
import { contactSupportNl } from '../contactSupport/nl'
import { riskDisclaimerNl } from '../riskDisclaimer/nl'
import { tradeNotificationsNl } from '../tradeNotifications/nl'
import { accountConfigNl } from './accountConfig/nl'
import { backtestNl } from './backtest/nl'
import { chromeNl } from './chrome/nl'
import { copierEngineNl } from './copierEngine/nl'
import { dashboardNl } from './dashboard/nl'
import { en } from './en'
import { legalNl } from './legalBundle/nl'
import { landingNl } from './landing/nl'
import { logsNl } from './logs/nl'
import { mergeLocaleBundle } from './merge'
import { pricingNl } from './pricing/nl'
import { settingsNl } from './settings/nl'
import { socialTradingNl } from './socialTrading/nl'
import { toolsNl } from './tools/nl'
import { tradingNl } from './trading/nl'
import type { Translations } from './types'

export const nl: Translations = mergeLocaleBundle(en, {
  ...chromeNl,
  ...dashboardNl,
  ...logsNl,
  ...settingsNl,
  ...accountConfigNl,
  ...backtestNl,
  ...pricingNl,
  ...toolsNl,
  ...tradingNl,
  ...socialTradingNl,
  ...legalNl,
  ...copierEngineNl,
  landing: landingNl,
  auth: authNl,
  channelWorker: channelWorkerNl,
  contactSupportPage: contactSupportNl,
  riskDisclaimerPage: riskDisclaimerNl,
  tradeNotifications: tradeNotificationsNl,
  management: {
    ...en.management,
    subtitle: 'Bekijk handelsactiviteiten van je copier.',
  },
  mirrorTradingPage: {
    ...en.mirrorTradingPage,
    title: 'Spiegelaccounts',
    subtitle: 'Kopieer trades van een masteraccount naar slave-accounts.',
    searchDescription: 'Kopieer trades van een masteraccount naar slave-accounts.',
    addMaster: 'Masteraccount toevoegen',
    mastersEmpty: 'Koppel het account waarvan de trades gekopieerd moeten worden.',
    emptyTitle: 'Nog geen spiegelaccounts',
    emptyBody:
      'Koppel een masteraccount waarvan de trades gekopieerd moeten worden, en voeg daarna slave-accounts toe met hun eigen risicinstellingen.',
    emptyStep1: 'Master toevoegen',
    emptyStep2: 'Slaves koppelen',
    emptyStep3: 'Kopiëren starten',
  },
})

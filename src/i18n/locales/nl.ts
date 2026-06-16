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
  ...legalNl,
  ...copierEngineNl,
  landing: landingNl,
  auth: authNl,
  channelWorker: channelWorkerNl,
  contactSupportPage: contactSupportNl,
  riskDisclaimerPage: riskDisclaimerNl,
  tradeNotifications: tradeNotificationsNl,
})

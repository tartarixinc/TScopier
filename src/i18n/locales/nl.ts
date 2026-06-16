import { authNl } from '../auth/nl'
import { channelWorkerNl } from '../channelWorker/nl'
import { contactSupportNl } from '../contactSupport/nl'
import { riskDisclaimerNl } from '../riskDisclaimer/nl'
import { tradeNotificationsNl } from '../tradeNotifications/nl'
import { chromeNl } from './chrome/nl'
import { dashboardNl } from './dashboard/nl'
import { en } from './en'
import { logsNl } from './logs/nl'
import { mergeLocaleBundle } from './merge'
import { settingsNl } from './settings/nl'
import type { Translations } from './types'

export const nl: Translations = mergeLocaleBundle(en, {
  ...chromeNl,
  ...dashboardNl,
  ...logsNl,
  ...settingsNl,
  auth: authNl,
  channelWorker: channelWorkerNl,
  contactSupportPage: contactSupportNl,
  riskDisclaimerPage: riskDisclaimerNl,
  tradeNotifications: tradeNotificationsNl,
})

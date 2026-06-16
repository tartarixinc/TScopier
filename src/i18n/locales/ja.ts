import { authJa } from '../auth/ja'
import { channelWorkerJa } from '../channelWorker/ja'
import { contactSupportJa } from '../contactSupport/ja'
import { riskDisclaimerJa } from '../riskDisclaimer/ja'
import { tradeNotificationsJa } from '../tradeNotifications/ja'
import { chromeJa } from './chrome/ja'
import { dashboardJa } from './dashboard/ja'
import { en } from './en'
import { logsJa } from './logs/ja'
import { mergeLocaleBundle } from './merge'
import { settingsJa } from './settings/ja'
import type { Translations } from './types'

export const ja: Translations = mergeLocaleBundle(en, {
  ...chromeJa,
  ...dashboardJa,
  ...logsJa,
  ...settingsJa,
  auth: authJa,
  channelWorker: channelWorkerJa,
  contactSupportPage: contactSupportJa,
  riskDisclaimerPage: riskDisclaimerJa,
  tradeNotifications: tradeNotificationsJa,
})

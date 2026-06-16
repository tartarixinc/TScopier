import { authRu } from '../auth/ru'
import { channelWorkerRu } from '../channelWorker/ru'
import { contactSupportRu } from '../contactSupport/ru'
import { riskDisclaimerRu } from '../riskDisclaimer/ru'
import { tradeNotificationsRu } from '../tradeNotifications/ru'
import { chromeRu } from './chrome/ru'
import { dashboardRu } from './dashboard/ru'
import { en } from './en'
import { logsRu } from './logs/ru'
import { mergeLocaleBundle } from './merge'
import { settingsRu } from './settings/ru'
import type { Translations } from './types'

export const ru: Translations = mergeLocaleBundle(en, {
  ...chromeRu,
  ...dashboardRu,
  ...logsRu,
  ...settingsRu,
  auth: authRu,
  channelWorker: channelWorkerRu,
  contactSupportPage: contactSupportRu,
  riskDisclaimerPage: riskDisclaimerRu,
  tradeNotifications: tradeNotificationsRu,
})

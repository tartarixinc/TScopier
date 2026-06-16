import { authPl } from '../auth/pl'
import { channelWorkerPl } from '../channelWorker/pl'
import { contactSupportPl } from '../contactSupport/pl'
import { riskDisclaimerPl } from '../riskDisclaimer/pl'
import { tradeNotificationsPl } from '../tradeNotifications/pl'
import { chromePl } from './chrome/pl'
import { dashboardPl } from './dashboard/pl'
import { en } from './en'
import { logsPl } from './logs/pl'
import { mergeLocaleBundle } from './merge'
import { settingsPl } from './settings/pl'
import type { Translations } from './types'

export const pl: Translations = mergeLocaleBundle(en, {
  ...chromePl,
  ...dashboardPl,
  ...logsPl,
  ...settingsPl,
  auth: authPl,
  channelWorker: channelWorkerPl,
  contactSupportPage: contactSupportPl,
  riskDisclaimerPage: riskDisclaimerPl,
  tradeNotifications: tradeNotificationsPl,
})

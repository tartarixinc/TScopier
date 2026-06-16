import { authSv } from '../auth/sv'
import { channelWorkerSv } from '../channelWorker/sv'
import { contactSupportSv } from '../contactSupport/sv'
import { riskDisclaimerSv } from '../riskDisclaimer/sv'
import { tradeNotificationsSv } from '../tradeNotifications/sv'
import { chromeSv } from './chrome/sv'
import { dashboardSv } from './dashboard/sv'
import { en } from './en'
import { logsSv } from './logs/sv'
import { mergeLocaleBundle } from './merge'
import { settingsSv } from './settings/sv'
import type { Translations } from './types'

export const sv: Translations = mergeLocaleBundle(en, {
  ...chromeSv,
  ...dashboardSv,
  ...logsSv,
  ...settingsSv,
  auth: authSv,
  channelWorker: channelWorkerSv,
  contactSupportPage: contactSupportSv,
  riskDisclaimerPage: riskDisclaimerSv,
  tradeNotifications: tradeNotificationsSv,
})

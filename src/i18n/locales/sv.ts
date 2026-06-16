import { authSv } from '../auth/sv'
import { channelWorkerSv } from '../channelWorker/sv'
import { contactSupportSv } from '../contactSupport/sv'
import { riskDisclaimerSv } from '../riskDisclaimer/sv'
import { tradeNotificationsSv } from '../tradeNotifications/sv'
import { accountConfigSv } from './accountConfig/sv'
import { backtestSv } from './backtest/sv'
import { chromeSv } from './chrome/sv'
import { copierEngineSv } from './copierEngine/sv'
import { dashboardSv } from './dashboard/sv'
import { en } from './en'
import { landingSv } from './landing/sv'
import { legalSv } from './legalBundle/sv'
import { logsSv } from './logs/sv'
import { mergeLocaleBundle } from './merge'
import { pricingSv } from './pricing/sv'
import { settingsSv } from './settings/sv'
import { toolsSv } from './tools/sv'
import { tradingSv } from './trading/sv'
import type { Translations } from './types'

export const sv: Translations = mergeLocaleBundle(en, {
  ...chromeSv,
  ...dashboardSv,
  ...logsSv,
  ...settingsSv,
  ...accountConfigSv,
  ...backtestSv,
  ...pricingSv,
  ...toolsSv,
  ...tradingSv,
  landing: landingSv,
  ...legalSv,
  ...copierEngineSv,
  auth: authSv,
  channelWorker: channelWorkerSv,
  contactSupportPage: contactSupportSv,
  riskDisclaimerPage: riskDisclaimerSv,
  tradeNotifications: tradeNotificationsSv,
})

import { authPl } from '../auth/pl'
import { channelWorkerPl } from '../channelWorker/pl'
import { contactSupportPl } from '../contactSupport/pl'
import { riskDisclaimerPl } from '../riskDisclaimer/pl'
import { tradeNotificationsPl } from '../tradeNotifications/pl'
import { accountConfigPl } from './accountConfig/pl'
import { backtestPl } from './backtest/pl'
import { chromePl } from './chrome/pl'
import { copierEnginePl } from './copierEngine/pl'
import { dashboardPl } from './dashboard/pl'
import { en } from './en'
import { logsPl } from './logs/pl'
import { mergeLocaleBundle } from './merge'
import { pricingPl } from './pricing/pl'
import { settingsPl } from './settings/pl'
import { toolsPl } from './tools/pl'
import { tradingPl } from './trading/pl'
import type { Translations } from './types'

export const pl: Translations = mergeLocaleBundle(en, {
  ...chromePl,
  ...dashboardPl,
  ...logsPl,
  ...settingsPl,
  ...accountConfigPl,
  ...backtestPl,
  ...pricingPl,
  ...toolsPl,
  ...tradingPl,
  ...copierEnginePl,
  auth: authPl,
  channelWorker: channelWorkerPl,
  contactSupportPage: contactSupportPl,
  riskDisclaimerPage: riskDisclaimerPl,
  tradeNotifications: tradeNotificationsPl,
})

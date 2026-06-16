import { authJa } from '../auth/ja'
import { channelWorkerJa } from '../channelWorker/ja'
import { contactSupportJa } from '../contactSupport/ja'
import { riskDisclaimerJa } from '../riskDisclaimer/ja'
import { tradeNotificationsJa } from '../tradeNotifications/ja'
import { accountConfigJa } from './accountConfig/ja'
import { backtestJa } from './backtest/ja'
import { chromeJa } from './chrome/ja'
import { copierEngineJa } from './copierEngine/ja'
import { dashboardJa } from './dashboard/ja'
import { en } from './en'
import { logsJa } from './logs/ja'
import { mergeLocaleBundle } from './merge'
import { pricingJa } from './pricing/ja'
import { settingsJa } from './settings/ja'
import { toolsJa } from './tools/ja'
import { tradingJa } from './trading/ja'
import type { Translations } from './types'

export const ja: Translations = mergeLocaleBundle(en, {
  ...chromeJa,
  ...dashboardJa,
  ...logsJa,
  ...settingsJa,
  ...accountConfigJa,
  ...backtestJa,
  ...pricingJa,
  ...toolsJa,
  ...tradingJa,
  ...copierEngineJa,
  auth: authJa,
  channelWorker: channelWorkerJa,
  contactSupportPage: contactSupportJa,
  riskDisclaimerPage: riskDisclaimerJa,
  tradeNotifications: tradeNotificationsJa,
})

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
import { legalJa } from './legalBundle/ja'
import { landingJa } from './landing/ja'
import { logsJa } from './logs/ja'
import { mergeLocaleBundle } from './merge'
import { pricingJa } from './pricing/ja'
import { settingsJa } from './settings/ja'
import { socialTradingJa } from './socialTrading/ja'
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
  ...socialTradingJa,
  ...legalJa,
  ...copierEngineJa,
  landing: landingJa,
  auth: authJa,
  channelWorker: channelWorkerJa,
  contactSupportPage: contactSupportJa,
  riskDisclaimerPage: riskDisclaimerJa,
  tradeNotifications: tradeNotificationsJa,
  management: {
    ...en.management,
    subtitle: 'コピアーの取引アクティビティを確認します。',
  },
  mirrorTradingPage: {
    ...en.mirrorTradingPage,
    title: 'ミラーアカウント',
    subtitle: 'マスター口座の取引をスレーブ口座にコピーします。',
    searchDescription: 'マスター口座の取引をスレーブ口座にコピーします。',
    addMaster: 'マスター口座を追加',
    mastersEmpty: 'コピー元となる口座を接続してください。',
    emptyTitle: 'ミラー口座はまだありません',
    emptyBody:
      'コピー元となるマスター口座を接続し、リスク設定を持つスレーブ口座を追加してください。',
    emptyStep1: 'マスターを追加',
    emptyStep2: 'スレーブを接続',
    emptyStep3: 'コピーを開始',
  },
})

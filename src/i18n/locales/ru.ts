import { authRu } from '../auth/ru'
import { channelWorkerRu } from '../channelWorker/ru'
import { contactSupportRu } from '../contactSupport/ru'
import { riskDisclaimerRu } from '../riskDisclaimer/ru'
import { tradeNotificationsRu } from '../tradeNotifications/ru'
import { accountConfigRu } from './accountConfig/ru'
import { backtestRu } from './backtest/ru'
import { chromeRu } from './chrome/ru'
import { copierEngineRu } from './copierEngine/ru'
import { dashboardRu } from './dashboard/ru'
import { en } from './en'
import { landingRu } from './landing/ru'
import { legalRu } from './legalBundle/ru'
import { logsRu } from './logs/ru'
import { mergeLocaleBundle } from './merge'
import { pricingRu } from './pricing/ru'
import { settingsRu } from './settings/ru'
import { socialTradingRu } from './socialTrading/ru'
import { toolsRu } from './tools/ru'
import { tradingRu } from './trading/ru'
import type { Translations } from './types'

export const ru: Translations = mergeLocaleBundle(en, {
  ...chromeRu,
  ...dashboardRu,
  ...logsRu,
  ...settingsRu,
  ...accountConfigRu,
  ...backtestRu,
  ...pricingRu,
  ...toolsRu,
  ...tradingRu,
  ...socialTradingRu,
  landing: landingRu,
  ...legalRu,
  ...copierEngineRu,
  auth: authRu,
  channelWorker: channelWorkerRu,
  contactSupportPage: contactSupportRu,
  riskDisclaimerPage: riskDisclaimerRu,
  tradeNotifications: tradeNotificationsRu,
  management: {
    ...en.management,
    subtitle: 'Просматривайте торговые активности вашего копировщика.',
  },
  mirrorTradingPage: {
    ...en.mirrorTradingPage,
    title: 'Зеркальные счета',
    subtitle: 'Копируйте сделки с главного счёта на подчинённые счета.',
    searchDescription: 'Копируйте сделки с главного счёта на подчинённые счета.',
    addMaster: 'Добавить главный счёт',
    mastersEmpty: 'Подключите счёт, сделки которого нужно копировать.',
    emptyTitle: 'Зеркальных счетов пока нет',
    emptyBody:
      'Подключите главный счёт, сделки которого нужно копировать, затем добавьте подчинённые счета с собственными настройками риска.',
    emptyStep1: 'Добавьте главный счёт',
    emptyStep2: 'Подключите подчинённые',
    emptyStep3: 'Начните копирование',
  },
})

import { authPl } from '../auth/pl'
import { channelWorkerPl } from '../channelWorker/pl'
import { contactSupportPl } from '../contactSupport/pl'
import { supportWidgetPl } from '../supportWidget/pl'
import { riskDisclaimerPl } from '../riskDisclaimer/pl'
import { tradeNotificationsPl } from '../tradeNotifications/pl'
import { accountConfigPl } from './accountConfig/pl'
import { backtestPl } from './backtest/pl'
import { chromePl } from './chrome/pl'
import { copierEnginePl } from './copierEngine/pl'
import { dashboardPl } from './dashboard/pl'
import { en } from './en'
import { landingPl } from './landing/pl'
import { legalPl } from './legalBundle/pl'
import { logsPl } from './logs/pl'
import { mergeLocaleBundle } from './merge'
import { signalActionsPl } from './signalHistory/actionLabels'
import { pricingPl } from './pricing/pl'
import { settingsPl } from './settings/pl'
import { socialTradingPl } from './socialTrading/pl'
import { toolsPl } from './tools/pl'
import { tradingPl } from './trading/pl'
import type { Translations } from './types'

export const pl: Translations = mergeLocaleBundle(en, {
  ...chromePl,
  ...dashboardPl,
  ...logsPl,
  signalHistoryPage: {
    ...en.signalHistoryPage,
    ...signalActionsPl,
  },
  ...settingsPl,
  ...accountConfigPl,
  ...backtestPl,
  ...pricingPl,
  ...toolsPl,
  ...tradingPl,
  ...socialTradingPl,
  landing: landingPl,
  ...legalPl,
  ...copierEnginePl,
  auth: authPl,
  channelWorker: channelWorkerPl,
  contactSupportPage: contactSupportPl,
  supportWidget: supportWidgetPl,
  riskDisclaimerPage: riskDisclaimerPl,
  tradeNotifications: tradeNotificationsPl,
  management: {
    ...en.management,
    subtitle: 'Przeglądaj aktywności tradingowe z kopiera.',
  },
  mirrorTradingPage: {
    ...en.mirrorTradingPage,
    title: 'Konta lustrzane',
    subtitle: 'Kopiuj transakcje z konta głównego na konta podrzędne.',
    searchDescription: 'Kopiuj transakcje z konta głównego na konta podrzędne.',
    addMaster: 'Dodaj konto główne',
    mastersEmpty: 'Połącz konto, którego transakcje mają być kopiowane.',
    emptyTitle: 'Brak kont lustrzanych',
    emptyBody:
      'Połącz konto główne, którego transakcje mają być kopiowane, a następnie dodaj konta podrzędne z własnymi ustawieniami ryzyka.',
    emptyStep1: 'Dodaj konto główne',
    emptyStep2: 'Dołącz konta podrzędne',
    emptyStep3: 'Rozpocznij kopiowanie',
  },
})

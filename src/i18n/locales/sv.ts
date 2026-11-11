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
import { socialTradingSv } from './socialTrading/sv'
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
  ...socialTradingSv,
  landing: landingSv,
  ...legalSv,
  ...copierEngineSv,
  auth: authSv,
  channelWorker: channelWorkerSv,
  contactSupportPage: contactSupportSv,
  riskDisclaimerPage: riskDisclaimerSv,
  tradeNotifications: tradeNotificationsSv,
  management: {
    ...en.management,
    subtitle: 'Granska handelsaktiviteter från din copier.',
  },
  mirrorTradingPage: {
    ...en.mirrorTradingPage,
    title: 'Spegelkonton',
    subtitle: 'Kopiera affärer från ett huvudkonto till slavkonton.',
    searchDescription: 'Kopiera affärer från ett huvudkonto till slavkonton.',
    addMaster: 'Lägg till huvudkonto',
    mastersEmpty: 'Anslut kontot vars affärer ska kopieras.',
    emptyTitle: 'Inga spegelkonton ännu',
    emptyBody:
      'Anslut ett huvudkonto vars affärer ska kopieras, och koppla sedan slavkonton med egna riskinställningar.',
    emptyStep1: 'Lägg till huvudkonto',
    emptyStep2: 'Koppla slavkonton',
    emptyStep3: 'Börja kopiera',
  },
})

import { authAr } from '../auth/ar'
import { channelWorkerAr } from '../channelWorker/ar'
import { contactSupportAr } from '../contactSupport/ar'
import { supportWidgetAr } from '../supportWidget/ar'
import { riskDisclaimerAr } from '../riskDisclaimer/ar'
import { tradeNotificationsAr } from '../tradeNotifications/ar'
import { accountConfigAr } from './accountConfig/ar'
import { backtestAr } from './backtest/ar'
import { chromeAr } from './chrome/ar'
import { copierEngineAr } from './copierEngine/ar'
import { dashboardAr } from './dashboard/ar'
import { en } from './en'
import { legalAr } from './legalBundle/ar'
import { landingAr } from './landing/ar'
import { logsAr } from './logs/ar'
import { mergeLocaleBundle } from './merge'
import { pricingAr } from './pricing/ar'
import { settingsAr } from './settings/ar'
import { signalHistoryAr } from './signalHistory/ar'
import { socialTradingAr } from './socialTrading/ar'
import { toolsAr } from './tools/ar'
import { tradingAr } from './trading/ar'
import type { Translations } from './types'

export const ar: Translations = mergeLocaleBundle(en, {
  ...chromeAr,
  ...dashboardAr,
  ...logsAr,
  ...settingsAr,
  ...accountConfigAr,
  ...backtestAr,
  ...pricingAr,
  ...toolsAr,
  ...tradingAr,
  ...socialTradingAr,
  ...legalAr,
  ...copierEngineAr,
  landing: landingAr,
  auth: authAr,
  channelWorker: channelWorkerAr,
  contactSupportPage: contactSupportAr,
  supportWidget: supportWidgetAr,
  riskDisclaimerPage: riskDisclaimerAr,
  tradeNotifications: tradeNotificationsAr,
  signalHistoryPage: signalHistoryAr,
  management: {
    ...en.management,
    subtitle: 'راجع نشاط تداول الناسخ.',
  },
  mirrorTradingPage: {
    ...en.mirrorTradingPage,
    title: 'حسابات المرآة',
    subtitle: 'انسخ الصفقات من حساب رئيسي إلى حسابات تابعة.',
    searchDescription: 'انسخ الصفقات من حساب رئيسي إلى حسابات تابعة.',
    addMaster: 'إضافة حساب رئيسي',
    mastersEmpty: 'اربط الحساب الذي يجب نسخ صفقاته.',
    emptyTitle: 'لا توجد حسابات مرآة بعد',
    emptyBody:
      'اربط حسابًا رئيسيًا تُنسَخ صفقاته، ثم أضف حسابات تابعة بإعدادات مخاطر خاصة بها.',
    emptyStep1: 'أضف حسابًا رئيسيًا',
    emptyStep2: 'اربط الحسابات التابعة',
    emptyStep3: 'ابدأ النسخ',
  },
})

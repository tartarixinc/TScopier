import type { Locale } from '../types'
import { channelWorkerEn } from './en'
import { channelWorkerEs } from './es'
import { channelWorkerFr } from './fr'
import type { ChannelWorkerTranslations } from './types'

const byLocale: Record<Locale, ChannelWorkerTranslations> = {
  en: channelWorkerEn,
  es: channelWorkerEs,
  fr: channelWorkerFr,
}

export function getChannelWorkerTranslations(locale: Locale): ChannelWorkerTranslations {
  return byLocale[locale] ?? channelWorkerEn
}

export type { ChannelWorkerTranslations }

import type { Translations } from '../types'

export type LegalBundleTranslations = Pick<
  Translations,
  'termsOfServicePage' | 'privacyPolicyPage' | 'cookiePolicyPage'
>

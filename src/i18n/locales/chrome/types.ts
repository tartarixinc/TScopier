import type { Translations } from '../types'

/** Sidebar, search, shared buttons, and page titles — high-traffic UI chrome. */
export type AppChromeTranslations = Pick<Translations, 'nav' | 'common' | 'globalSearch' | 'pages'>

import { useLocale } from '../../../context/LocaleContext'
import { getProviderPageCopy, type ProviderPageCopy } from '../../../i18n/locales/landing/providerPage'

/** Fractal-noise grain (tiled inline SVG) laid over dark surfaces. */
export const NOISE_BG =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.1' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.9 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")"

export function useProviderPage(): ProviderPageCopy {
  const { locale } = useLocale()
  return getProviderPageCopy(locale)
}

export function initials(name: string) {
  return name
    .split(' ')
    .map(part => part[0])
    .join('')
    .slice(0, 2)
}

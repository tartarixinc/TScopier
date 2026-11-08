import { ArrowLeft } from 'lucide-react'
import { useLocale } from '../../context/LocaleContext'
import { marketingUrl } from '../../lib/site'

export function AuthBackHome() {
  const { auth } = useLocale()

  return (
    <a
      href={marketingUrl('/')}
      className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-neutral-900 transition-colors hover:text-neutral-900 dark:text-neutral-50 dark:hover:text-neutral-100"
    >
      <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden />
      {auth.nav.backHome}
    </a>
  )
}

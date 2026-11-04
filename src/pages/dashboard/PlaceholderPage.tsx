import { Construction } from 'lucide-react'
import { PageHeader } from '../../components/layout/PageHeader'
import { PageShell } from '../../components/layout/PageShell'
import { useT } from '../../context/LocaleContext'

interface PlaceholderPageProps {
  title: string
}

export function PlaceholderPage({ title }: PlaceholderPageProps) {
  const t = useT()

  return (
    <PageShell maxWidth="sm">
      <PageHeader title={title} />
      <div className="rounded-xl border border-dashed border-neutral-200 bg-white py-20 text-center dark:border-neutral-700 dark:bg-neutral-950">
        <Construction className="mx-auto mb-3 h-10 w-10 text-neutral-900 dark:text-neutral-50" />
        <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50">{t.common.comingSoon}</p>
        <p className="mt-1 text-xs text-neutral-900 dark:text-neutral-50">{t.common.underDevelopment}</p>
      </div>
    </PageShell>
  )
}

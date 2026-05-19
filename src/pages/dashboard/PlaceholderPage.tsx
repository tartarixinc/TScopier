import { Construction } from 'lucide-react'
import { PageHeader } from '../../components/layout/PageHeader'
import { PageShell } from '../../components/layout/PageShell'
import { useT } from '../../context/LocaleContext'

interface PlaceholderPageProps {
  title: string
  description: string
}

export function PlaceholderPage({ title, description }: PlaceholderPageProps) {
  const t = useT()

  return (
    <PageShell maxWidth="sm">
      <PageHeader title={title} subtitle={description} />
      <div className="rounded-xl border border-dashed border-neutral-200 bg-white py-20 text-center dark:border-neutral-700 dark:bg-neutral-900">
        <Construction className="mx-auto mb-3 h-10 w-10 text-neutral-300 dark:text-neutral-600" />
        <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400">{t.common.comingSoon}</p>
        <p className="mt-1 text-xs text-neutral-300 dark:text-neutral-600">{t.common.underDevelopment}</p>
      </div>
    </PageShell>
  )
}

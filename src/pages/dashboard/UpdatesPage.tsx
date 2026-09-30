import { Sparkles, Bug, Wrench, Megaphone } from 'lucide-react'
import { PageShell } from '../../components/layout/PageShell'
import { PageHeader } from '../../components/layout/PageHeader'
import { PLATFORM_UPDATES, type PlatformUpdate } from '../../lib/platformUpdates'
import { useT } from '../../context/LocaleContext'

const TYPE_CONFIG: Record<PlatformUpdate['type'], { icon: typeof Sparkles; color: string }> = {
  feature: { icon: Sparkles, color: 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400' },
  fix: { icon: Bug, color: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400' },
  improvement: { icon: Wrench, color: 'bg-teal-50 text-teal-700 dark:bg-teal-950/40 dark:text-teal-400' },
}

function typeLabel(type: PlatformUpdate['type'], t: ReturnType<typeof useT>): string {
  const map: Record<PlatformUpdate['type'], string> = {
    feature: t.nav.updatesPage.typeFeature,
    fix: t.nav.updatesPage.typeFix,
    improvement: t.nav.updatesPage.typeImprovement,
  }
  return map[type]
}

function UpdateCard({ update, t }: { update: PlatformUpdate; t: ReturnType<typeof useT> }) {
  const config = TYPE_CONFIG[update.type]
  const Icon = config.icon
  const label = typeLabel(update.type, t)

  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="flex items-start gap-3">
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${config.color}`}>
          <Icon className="h-4.5 w-4.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${config.color}`}>
              {label}
            </span>
            <span className="text-xs text-neutral-400 dark:text-neutral-500">{update.date}</span>
          </div>
          <h3 className="mt-1.5 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            {update.title}
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
            {update.description}
          </p>
        </div>
      </div>
    </div>
  )
}

export function UpdatesPage() {
  const t = useT()

  return (
    <PageShell maxWidth="md">
      <PageHeader
        title={t.nav.updatesPage.title}
        subtitle={t.nav.updatesPage.subtitle}
      />

      {PLATFORM_UPDATES.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Megaphone className="h-10 w-10 text-neutral-300 dark:text-neutral-600" />
          <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">
            {t.nav.updatesPage.empty}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {PLATFORM_UPDATES.map(update => (
            <UpdateCard key={update.id} update={update} t={t} />
          ))}
        </div>
      )}
    </PageShell>
  )
}

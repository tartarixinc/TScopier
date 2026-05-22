import { Calendar, Newspaper } from 'lucide-react'
import { useT } from '../../../../context/LocaleContext'

export function NewsCalendarVisual() {
  const v = useT().landing.features.visuals.news

  return (
    <div className="relative flex h-full min-h-[240px] items-center justify-center p-2">
      <div className="grid w-full max-w-md gap-4 sm:grid-cols-2">
        <div className="marketing-feature-node space-y-2 p-3">
          <p className="text-xs font-semibold text-neutral-700 dark:text-neutral-200">{v.calendarTitle}</p>
          {v.events.map((event) => (
            <div
              key={event.name}
              className="flex items-center justify-between gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-2.5 py-2 dark:border-neutral-700 dark:bg-neutral-800/60"
            >
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-neutral-800 dark:text-neutral-100">
                  {event.name}
                </p>
                <p className="text-[10px] text-neutral-500">{event.time}</p>
              </div>
              <span
                className={
                  event.impact === 'high'
                    ? 'shrink-0 rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300'
                    : 'shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300'
                }
              >
                {event.impact === 'high' ? v.impactHigh : v.impactMed}
              </span>
            </div>
          ))}
        </div>

        <div className="relative flex min-h-[200px] items-center justify-center">
          <div className="marketing-feature-orbit-ring marketing-feature-orbit-ring--outer" aria-hidden />
          <div className="marketing-feature-orbit-ring marketing-feature-orbit-ring--inner" aria-hidden />
          <div className="marketing-feature-hub relative z-10 h-14 w-14 rounded-full p-0">
            <Newspaper className="h-6 w-6 text-white" aria-hidden />
          </div>
          {v.headlines.map((item, i) => (
            <div
              key={item.label}
              className={`marketing-feature-orbit-item marketing-feature-orbit-item--${i + 1}`}
            >
              <span className="text-[10px] font-medium text-neutral-700 dark:text-neutral-200">
                {item.label}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="marketing-feature-float marketing-feature-float--tl">
        <Calendar className="h-3 w-3" aria-hidden />
        {v.pillCalendar}
      </div>
    </div>
  )
}

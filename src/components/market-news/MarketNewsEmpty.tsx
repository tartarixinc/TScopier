import { Newspaper } from 'lucide-react'

interface MarketNewsEmptyProps {
  title: string
  subtitle: string
}

export function MarketNewsEmpty({ title, subtitle }: MarketNewsEmptyProps) {
  return (
    <div className="rounded-xl border border-dashed border-neutral-200 bg-white py-16 text-center dark:border-neutral-700 dark:bg-neutral-950">
      <Newspaper className="mx-auto mb-3 h-10 w-10 text-neutral-900 dark:text-neutral-50" />
      <p className="text-sm font-medium text-neutral-900 dark:text-neutral-50">{title}</p>
      <p className="mt-1 text-xs text-neutral-900 dark:text-neutral-50">{subtitle}</p>
    </div>
  )
}

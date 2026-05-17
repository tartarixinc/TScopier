import { Newspaper } from 'lucide-react'

interface MarketNewsEmptyProps {
  title: string
  subtitle: string
}

export function MarketNewsEmpty({ title, subtitle }: MarketNewsEmptyProps) {
  return (
    <div className="rounded-xl border border-dashed border-neutral-200 bg-white py-16 text-center dark:border-neutral-700 dark:bg-neutral-900">
      <Newspaper className="mx-auto mb-3 h-10 w-10 text-neutral-300 dark:text-neutral-600" />
      <p className="text-sm font-medium text-neutral-600 dark:text-neutral-400">{title}</p>
      <p className="mt-1 text-xs text-neutral-400 dark:text-neutral-500">{subtitle}</p>
    </div>
  )
}

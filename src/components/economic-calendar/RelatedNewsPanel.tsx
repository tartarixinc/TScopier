import { ExternalLink } from 'lucide-react'
import type { MarketNewsArticle } from '../../lib/marketNewsTypes'
import { articleTimestampSec, formatRelative } from '../../lib/formatRelative'

interface RelatedNewsPanelProps {
  articles: MarketNewsArticle[]
  title: string
  empty: string
  readArticle: string
}

export function RelatedNewsPanel({ articles, title, empty, readArticle }: RelatedNewsPanelProps) {
  return (
    <div className="rounded-xl border border-neutral-200/80 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <div className="border-b border-neutral-100 px-4 py-3 dark:border-neutral-800">
        <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{title}</h2>
      </div>
      <div className="max-h-[32rem] overflow-y-auto divide-y divide-neutral-100 dark:divide-neutral-800">
        {articles.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-neutral-500 dark:text-neutral-400">{empty}</p>
        ) : (
          articles.map((article) => (
            <a
              key={article.id}
              href={article.url || undefined}
              target="_blank"
              rel="noopener noreferrer"
              className="block px-4 py-3 transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
            >
              <p className="text-sm font-medium leading-snug text-neutral-900 dark:text-neutral-50 line-clamp-2">
                {article.headline}
              </p>
              <div className="mt-1 flex items-center justify-between gap-2 text-xs text-neutral-500 dark:text-neutral-400">
                <span className="truncate">{article.source || '—'}</span>
                <span className="shrink-0 tabular-nums">{formatRelative(articleTimestampSec(article))}</span>
              </div>
              {article.url ? (
                <span className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-teal-600 dark:text-teal-400">
                  {readArticle}
                  <ExternalLink className="h-3 w-3" />
                </span>
              ) : null}
            </a>
          ))
        )}
      </div>
    </div>
  )
}

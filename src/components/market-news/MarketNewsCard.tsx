import { ExternalLink } from 'lucide-react'
import type { MarketNewsArticle } from '../../lib/marketNewsTypes'
import { articleTimestampSec, formatRelative } from '../../lib/formatRelative'
import { NewsArticleImage } from './NewsArticleImage'
import { plainNewsText } from '../../lib/stripHtml'
import { formatForexPairLabel } from '../../lib/forexNewsSymbols'

interface MarketNewsCardProps {
  article: MarketNewsArticle
  readArticle: string
}

export function MarketNewsCard({ article, readArticle }: MarketNewsCardProps) {
  const timeLabel = formatRelative(articleTimestampSec(article))
  const headline = plainNewsText(article.headline, 'headline')
  const summary = article.summary ? plainNewsText(article.summary, 'summary') : ''
  const pairLabel = article.related?.trim() ? formatForexPairLabel(article.related) : ''
  const content = (
    <>
      <NewsArticleImage
        image={article.image}
        alt={headline}
        className="aspect-[16/9] w-full"
        iconClassName="h-8 w-8"
      />
      <div className="flex flex-1 flex-col p-4">
        <div className="mb-2 flex items-center justify-between gap-2 text-xs text-neutral-500 dark:text-neutral-400">
          <span className="flex min-w-0 items-center gap-2 truncate">
            {pairLabel ? (
              <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 font-semibold tabular-nums text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                {pairLabel}
              </span>
            ) : null}
            <span className="truncate font-medium">{article.source || '—'}</span>
          </span>
          <span className="shrink-0 tabular-nums">{timeLabel}</span>
        </div>
        <h3 className="line-clamp-3 text-sm font-semibold leading-snug text-neutral-900 dark:text-neutral-50">
          {headline}
        </h3>
        {summary ? (
          <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-neutral-600 dark:text-neutral-400">
            {summary}
          </p>
        ) : null}
        {article.url ? (
          <span className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-teal-600 dark:text-teal-400">
            {readArticle}
            <ExternalLink className="h-3.5 w-3.5" />
          </span>
        ) : null}
      </div>
    </>
  )

  const className =
    'flex h-full flex-col overflow-hidden rounded-xl border border-neutral-200/80 bg-white shadow-sm transition-all hover:border-teal-200/80 hover:shadow-md dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-teal-800/50'

  if (article.url) {
    return (
      <a
        href={article.url}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
      >
        {content}
      </a>
    )
  }

  return <article className={className}>{content}</article>
}

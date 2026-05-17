import { ExternalLink } from 'lucide-react'
import type { MarketNewsArticle } from '../../lib/marketNewsTypes'
import { articleTimestampSec, formatRelative } from '../../lib/formatRelative'
import { NewsArticleImage } from './NewsArticleImage'
import { plainNewsText } from '../../lib/stripHtml'
import { formatForexPairLabel } from '../../lib/forexNewsSymbols'

interface MarketNewsHeroProps {
  article: MarketNewsArticle
  forexBadge: string
  readArticle: string
}

export function MarketNewsHero({ article, forexBadge, readArticle }: MarketNewsHeroProps) {
  const timeLabel = formatRelative(articleTimestampSec(article))
  const headline = plainNewsText(article.headline, 'headline')
  const summary = article.summary ? plainNewsText(article.summary, 'summary') : ''
  const pairLabel = article.related?.trim() ? formatForexPairLabel(article.related) : ''

  return (
    <article className="group relative overflow-hidden rounded-2xl border border-neutral-200/80 bg-white shadow-sm transition-shadow hover:shadow-md dark:border-neutral-800 dark:bg-neutral-900">
      <div className="grid md:grid-cols-2">
        <NewsArticleImage
          image={article.image}
          alt={headline}
          className="aspect-[16/10] md:aspect-auto md:min-h-[280px]"
          iconClassName="h-14 w-14"
        />
        <div className="flex flex-col justify-center p-6 lg:p-8">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-teal-50 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-teal-700 dark:bg-teal-950/60 dark:text-teal-300">
              {forexBadge}
            </span>
            {pairLabel ? (
              <span className="rounded-full bg-neutral-100 px-2.5 py-0.5 text-xs font-semibold tabular-nums text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
                {pairLabel}
              </span>
            ) : null}
            {article.source ? (
              <span className="text-xs font-medium text-neutral-500 dark:text-neutral-400">
                {article.source}
              </span>
            ) : null}
            <span className="text-xs text-neutral-400 dark:text-neutral-500">{timeLabel}</span>
          </div>
          <h2 className="text-xl font-bold leading-snug text-neutral-900 dark:text-neutral-50 lg:text-2xl">
            {headline}
          </h2>
          {summary ? (
            <p className="mt-3 line-clamp-4 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
              {summary}
            </p>
          ) : null}
          {article.url ? (
            <a
              href={article.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-teal-600 hover:text-teal-700 dark:text-teal-400 dark:hover:text-teal-300"
            >
              {readArticle}
              <ExternalLink className="h-4 w-4" />
            </a>
          ) : null}
        </div>
      </div>
    </article>
  )
}

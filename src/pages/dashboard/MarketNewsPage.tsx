import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useT } from '../../context/LocaleContext'
import { interpolate } from '../../i18n/interpolate'
import { fetchForexNews, peekMarketNewsCache } from '../../lib/marketNewsApi'
import type { MarketNewsArticle } from '../../lib/marketNewsTypes'
import { MarketNewsHero } from '../../components/market-news/MarketNewsHero'
import { MarketNewsCard } from '../../components/market-news/MarketNewsCard'
import { MarketNewsFilters } from '../../components/market-news/MarketNewsFilters'
import { formatForexPairLabel } from '../../lib/forexNewsSymbols'
import { MarketNewsSkeleton } from '../../components/market-news/MarketNewsSkeleton'
import { MarketNewsEmpty } from '../../components/market-news/MarketNewsEmpty'
import { Button } from '../../components/ui/Button'
import { Alert } from '../../components/ui/Alert'

function newsFetchOptions(symbol: string) {
  return { symbols: symbol.trim() || undefined }
}

export function MarketNewsPage() {
  const t = useT()
  const mn = t.marketNews

  const [symbol, setSymbol] = useState('')
  const initialCache = peekMarketNewsCache(newsFetchOptions(''))

  const [articles, setArticles] = useState<MarketNewsArticle[]>(
    () => initialCache?.response.articles ?? [],
  )
  const [loading, setLoading] = useState(() => !initialCache)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(() =>
    initialCache ? new Date(initialCache.fetchedAt) : null,
  )

  const load = useCallback(async (isRefresh = false) => {
    const fetchOpts = newsFetchOptions(symbol)

    if (!isRefresh) {
      const cached = peekMarketNewsCache(fetchOpts)
      if (cached) {
        setArticles(cached.response.articles)
        setLastUpdated(new Date(cached.fetchedAt))
        setError(null)
        setLoading(false)
        setRefreshing(false)
        return
      }
    }

    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const { articles: next } = await fetchForexNews({
        ...fetchOpts,
        forceRefresh: isRefresh,
      })
      setArticles(next)
      setLastUpdated(new Date())
    } catch (e) {
      setError(e instanceof Error ? e.message : mn.loadError)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [mn.loadError, symbol])

  useEffect(() => {
    void load()
  }, [load])

  const hero = articles[0] ?? null
  const rest = useMemo(() => (articles.length > 1 ? articles.slice(1) : []), [articles])

  const lastUpdatedLabel = lastUpdated
    ? interpolate(mn.lastUpdated, {
        time: lastUpdated.toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
        }),
      })
    : null

  return (
    <div className="p-4 lg:p-8 max-w-6xl mx-auto space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-50">{mn.title}</h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1 max-w-xl">{mn.subtitle}</p>
        </div>
        <div className="flex flex-col items-end gap-2 sm:flex-row sm:items-center">
          {lastUpdatedLabel && !loading ? (
            <span className="text-xs text-neutral-400 dark:text-neutral-500 tabular-nums">
              {lastUpdatedLabel}
            </span>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            loading={refreshing}
            disabled={loading}
            onClick={() => void load(true)}
          >
            <RefreshCw className="h-4 w-4" />
            {t.common.refresh}
          </Button>
        </div>
      </div>

      {error ? <Alert>{error}</Alert> : null}

      <MarketNewsFilters
        symbol={symbol}
        labels={{ symbol: mn.symbol, symbolAll: mn.symbolAll }}
        onSymbolChange={setSymbol}
      />

      {loading ? (
        <MarketNewsSkeleton />
      ) : articles.length === 0 && !error ? (
        <MarketNewsEmpty
          title={symbol ? mn.emptyFilterTitle : mn.emptyTitle}
          subtitle={
            symbol
              ? interpolate(mn.emptyFilterSubtitle, { pair: formatForexPairLabel(symbol) })
              : mn.emptySubtitle
          }
        />
      ) : (
        <div className="space-y-6">
          {hero ? (
            <MarketNewsHero
              article={hero}
              forexBadge={mn.forexBadge}
              readArticle={mn.readArticle}
            />
          ) : null}
          {rest.length > 0 ? (
            <section>
              <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                {mn.moreHeadlines}
              </h2>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {rest.map((article) => (
                  <MarketNewsCard
                    key={article.id}
                    article={article}
                    readArticle={mn.readArticle}
                  />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      )}

      <footer className="border-t border-neutral-200 pt-6 dark:border-neutral-800">
        <a
          href="https://site.financialmodelingprep.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-neutral-400 hover:text-teal-600 dark:hover:text-teal-400"
        >
          {mn.dataByFmp}
        </a>
      </footer>
    </div>
  )
}

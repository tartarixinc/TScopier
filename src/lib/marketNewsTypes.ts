export interface MarketNewsArticle {
  id: number
  category: string
  datetime: number
  headline: string
  summary: string
  source: string
  image: string
  url: string
  related: string
}

export interface ForexNewsResponse {
  articles: MarketNewsArticle[]
  page?: number
  limit?: number
}
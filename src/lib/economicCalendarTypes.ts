export type EconomicImpact = 'low' | 'medium' | 'high'

export interface EconomicCalendarEvent {
  id: string
  datetime: string
  country: string
  currency: string
  event: string
  impact: EconomicImpact
  actual: number | null
  forecast: number | null
  previous: number | null
  unit: string
  change: number | null
}

export interface EconomicCalendarResponse {
  events: EconomicCalendarEvent[]
  from: string
  to: string
}

export type CalendarImpactFilter = 'all' | EconomicImpact
export type CalendarCountryFilter = 'ALL' | string

export interface EconomicCalendarQuery {
  from?: string
  to?: string
  country?: CalendarCountryFilter
  impact?: CalendarImpactFilter
}

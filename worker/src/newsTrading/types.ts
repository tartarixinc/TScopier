export type EconomicImpact = 'low' | 'medium' | 'high'

export interface EconomicCalendarEvent {
  id: string
  datetime: string
  country: string
  currency: string
  event: string
  impact: EconomicImpact
}

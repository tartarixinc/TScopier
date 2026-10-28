import type { TradeNotification } from './tradeNotifications'

export type SocialNotificationRow = {
  id: string
  event_type: 'social_follow_accepted' | 'social_copy_activated' | 'social_copy_stopped' | 'social_copy_suspended'
  title: string
  body: string
  action_url: string | null
  read_at: string | null
  created_at: string
}

export const SOCIAL_NOTIFICATION_SELECT = 'id,event_type,title,body,action_url,read_at,created_at'

export function socialNotificationFromRow(row: SocialNotificationRow): TradeNotification {
  return {
    id: `social:${row.id}`,
    headline: row.event_type,
    title: row.title,
    body: row.body,
    symbol: null,
    createdAt: row.created_at,
    actionUrl: row.action_url,
    actionLabel: row.action_url ? 'View' : null,
    readAt: row.read_at,
  }
}

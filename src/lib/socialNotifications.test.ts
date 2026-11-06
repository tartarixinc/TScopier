import assert from 'node:assert/strict'
import test from 'node:test'
import { socialNotificationFromRow } from './socialNotifications'
import { countUnreadNotifications } from './tradeNotifications'

test('maps a persistent social notification to a linked bell item', () => {
  const item = socialNotificationFromRow({
    id: 'notification-1', event_type: 'social_copy_activated', title: 'New copier activated',
    body: 'A subscription is active.', action_url: '/social-trading/user-2', read_at: null,
    created_at: '2026-10-28T12:00:00.000Z',
  })
  assert.equal(item.headline, 'social_copy_activated')
  assert.equal(item.actionUrl, '/social-trading/user-2')
  assert.equal(item.readAt, null)
})

test('persistent read state overrides the legacy local bell timestamp', () => {
  const unread = socialNotificationFromRow({ id: 'n1', event_type: 'social_follow_accepted', title: 'Follower', body: 'Body', action_url: null, read_at: null, created_at: '2026-10-20T00:00:00Z' })
  const read = { ...unread, id: 'social:n2', readAt: '2026-10-21T00:00:00Z' }
  assert.equal(countUnreadNotifications([unread, read], '2026-10-28T00:00:00Z'), 1)
})

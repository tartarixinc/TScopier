import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  formatNotificationDayLabel,
  groupNotificationsByDay,
  localDayKey,
} from './notificationDayGroups'

describe('notificationDayGroups', () => {
  const now = new Date('2026-06-05T15:00:00.000Z')
  const labels = { today: 'Today', yesterday: 'Yesterday', locale: 'en-US', now }

  it('labels today and yesterday', () => {
    assert.equal(localDayKey('2026-06-05T10:00:00.000Z', now), '2026-06-05')
    assert.equal(formatNotificationDayLabel('2026-06-05', labels), 'Today')
    assert.equal(formatNotificationDayLabel('2026-06-04', labels), 'Yesterday')
  })

  it('groups items by local day preserving order', () => {
    const groups = groupNotificationsByDay(
      [
        { id: '1', createdAt: '2026-06-05T12:00:00.000Z' },
        { id: '2', createdAt: '2026-06-05T08:00:00.000Z' },
        { id: '3', createdAt: '2026-06-04T20:00:00.000Z' },
      ],
      labels,
    )
    assert.equal(groups.length, 2)
    assert.equal(groups[0].label, 'Today')
    assert.equal(groups[0].items.length, 2)
    assert.equal(groups[1].label, 'Yesterday')
    assert.equal(groups[1].items.length, 1)
  })
})

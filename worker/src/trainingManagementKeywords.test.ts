import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyManagementGroupsToChannelKeywords,
  bucketFlatManagementCues,
  resolveManagementGroups,
} from './trainingManagementKeywords'

describe('trainingManagementKeywords', () => {
  it('buckets French close-all into management groups', () => {
    const groups = bucketFlatManagementCues(['FERMEZ TOUT', 'BREAK EVEN'])
    assert.ok(groups.close_all.includes('FERMEZ TOUT'))
    assert.ok(groups.break_even.includes('BREAK EVEN'))
  })

  it('does not bucket conditional close cues into close_all', () => {
    const groups = bucketFlatManagementCues([
      'If you are happy, close now',
      'Close if you are satisfied',
    ])
    assert.equal(groups.close_all.length, 0)
  })

  it('maps management groups to channel_keywords close fields', () => {
    const groups = resolveManagementGroups({
      management_keyword_groups: {
        close_all: ['FERMEZ TOUT'],
        close_partial: [],
        close_half: [],
        break_even: ['POINT MORT'],
        modify_sl: ['DÉPLACER LE SL'],
        modify_tp: [],
        close_worse_entries: [],
      },
    })
    const applied = applyManagementGroupsToChannelKeywords(
      { update: { close_full: 'CLOSE FULL' }, additional: { close_all: 'CLOSE ALL' } },
      groups,
      { replace: true },
    )
    assert.match(applied.additional.close_all ?? '', /FERMEZ TOUT/i)
    assert.match(applied.update.break_even ?? '', /POINT MORT/i)
    assert.match(applied.update.adjust_sl ?? '', /DÉPLACER LE SL/i)
  })
})

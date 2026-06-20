import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  buildTscopierCommentPrefix,
  resolveChannelLabelForComment,
  sanitizeChannelCommentSlug,
  areOrderCommentsEnabled,
  resolveTscopierCommentPrefix,
  appendOrderCommentSuffix,
  buildBasketRefreshComment,
} from './tradeComment'

test('resolveChannelLabelForComment prefers display_name', () => {
  assert.equal(resolveChannelLabelForComment('VIP Gold', 'vipgold'), 'VIP Gold')
  assert.equal(resolveChannelLabelForComment('', 'vipgold'), 'vipgold')
})

test('sanitizeChannelCommentSlug strips non-alphanumeric', () => {
  assert.equal(sanitizeChannelCommentSlug('VIP Gold Signals'), 'VIPGoldSigna')
  assert.equal(sanitizeChannelCommentSlug('@my_channel'), 'mychannel')
})

test('buildTscopierCommentPrefix embeds channel slug', () => {
  const id = '28785f02-000b-4860-a3dd-58d74f890a5d'
  assert.equal(buildTscopierCommentPrefix(id, 'GoldSignals'), 'TScopier:GoldSignals:28785f02')
  assert.equal(buildTscopierCommentPrefix(id, null), 'TScopier:28785f02')
})

test('areOrderCommentsEnabled defaults on unless explicitly false', () => {
  assert.equal(areOrderCommentsEnabled(undefined), true)
  assert.equal(areOrderCommentsEnabled({}), true)
  assert.equal(areOrderCommentsEnabled({ order_comments_enabled: true }), true)
  assert.equal(areOrderCommentsEnabled({ order_comments_enabled: false }), false)
})

test('resolveTscopierCommentPrefix respects order_comments_enabled', () => {
  const id = '28785f02-000b-4860-a3dd-58d74f890a5d'
  assert.equal(resolveTscopierCommentPrefix(id, 'Gold', { order_comments_enabled: false }), '')
  assert.equal(resolveTscopierCommentPrefix(id, 'Gold', {}), 'TScopier:Gold:28785f02')
})

test('appendOrderCommentSuffix returns empty when prefix is empty', () => {
  assert.equal(appendOrderCommentSuffix('', ':tp1'), '')
  assert.equal(appendOrderCommentSuffix('TScopier:abc', ':tp1'), 'TScopier:abc:tp1')
})

test('buildBasketRefreshComment empty when comments disabled', () => {
  const id = '28785f02-000b-4860-a3dd-58d74f890a5d'
  assert.equal(buildBasketRefreshComment(id, { order_comments_enabled: false }), '')
  assert.equal(buildBasketRefreshComment(id, {}), 'TScopier:28785f02:refresh')
})

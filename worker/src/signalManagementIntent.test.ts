import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  looksLikeChannelManagementUpdate,
  looksLikeDeletePendingsCommand,
  looksLikeExplicitFullCloseCommand,
  partialCloseFractionFromMessage,
} from './signalManagementIntent'
import { normalizeSignalMessageForParse } from './normalizeTelegramMessageText'

test('looksLikeDeletePendingsCommand: delete/cancel limit and trade invalid', () => {
  assert.equal(looksLikeDeletePendingsCommand('Delete sell limit'), true)
  assert.equal(looksLikeDeletePendingsCommand('Delete buy limit'), true)
  assert.equal(looksLikeDeletePendingsCommand('cancel limit'), true)
  assert.equal(looksLikeDeletePendingsCommand('delete pending'), true)
  assert.equal(looksLikeDeletePendingsCommand('Trade invalid'), true)
  assert.equal(looksLikeDeletePendingsCommand('invalid setup'), true)
  assert.equal(looksLikeDeletePendingsCommand('Close all now'), false)
  assert.equal(looksLikeDeletePendingsCommand('Gold buy now'), false)
})

test('looksLikeChannelManagementUpdate: delete pendings cues', () => {
  assert.equal(looksLikeChannelManagementUpdate('Delete sell limit'), true)
  assert.equal(looksLikeChannelManagementUpdate('Trade invalid'), true)
})

test('looksLikeExplicitFullCloseCommand: accepts two-word close phrases', () => {
  assert.equal(looksLikeExplicitFullCloseCommand('Close all now'), true)
  assert.equal(looksLikeExplicitFullCloseCommand('close trade now'), true)
  assert.equal(looksLikeExplicitFullCloseCommand('close gold'), true)
  assert.equal(looksLikeExplicitFullCloseCommand('close XAUUSD'), true)
  assert.equal(looksLikeExplicitFullCloseCommand('FERMEZ TOUT MAINTENANT'), true)
  assert.equal(looksLikeExplicitFullCloseCommand('CERRAR TODO AHORA'), true)
  assert.equal(looksLikeExplicitFullCloseCommand('ZAMKNIJ WSZYSTKO TERAZ'), true)
})

test('looksLikeExplicitFullCloseCommand: rejects prose close to', () => {
  const msg = 'receive it before price is even close to our entry'
  assert.equal(looksLikeExplicitFullCloseCommand(msg), false)
})

test('looksLikeChannelManagementUpdate: partial lotsize close', () => {
  assert.equal(
    looksLikeChannelManagementUpdate('Make sure to secure 30% profits by closing partial lotsize'),
    true,
  )
})

test('looksLikeChannelManagementUpdate: move stop to breakeven', () => {
  assert.equal(
    looksLikeChannelManagementUpdate('+50 pips running, you can move stop to breakeven.'),
    true,
  )
})

test('looksLikeChannelManagementUpdate: stretched breakevennnn', () => {
  assert.equal(
    looksLikeChannelManagementUpdate(normalizeSignalMessageForParse('Set breakevennnnnnnn')),
    true,
  )
})

test('looksLikeChannelManagementUpdate: French close all now', () => {
  assert.equal(looksLikeChannelManagementUpdate('FERMEZ TOUT MAINTENANT'), true)
})

test('looksLikeChannelManagementUpdate: SL to entry / BE without a digit (breakeven)', () => {
  assert.equal(looksLikeChannelManagementUpdate('SL to Entry'), true)
  assert.equal(looksLikeChannelManagementUpdate('SL to BE'), true)
  assert.equal(looksLikeChannelManagementUpdate('move stop to entry'), true)
})

test('looksLikeChannelManagementUpdate: Make / Bring SL verbs', () => {
  assert.equal(looksLikeChannelManagementUpdate('Make SL to 4155'), true)
  assert.equal(looksLikeChannelManagementUpdate('Make SL 4155'), true)
  assert.equal(looksLikeChannelManagementUpdate('Bring SL to 4155'), true)
})

test('looksLikeChannelManagementUpdate: SL to entry stays management even for trained-management channels', () => {
  // Channels with trained management config previously skipped the universal
  // breakeven cue list — "SL to Entry" then leaked to the AI entry parser.
  const trainedLexicon = { action_aliases: { modify: ['adjust sl'] } } as never
  assert.equal(
    looksLikeChannelManagementUpdate('SL to Entry', undefined, trainedLexicon),
    true,
  )
})

test('looksLikeChannelManagementUpdate: TP modifications are management class', () => {
  assert.equal(looksLikeChannelManagementUpdate('You can add a Take Profit of 30 pips'), true)
  assert.equal(looksLikeChannelManagementUpdate('30 pips take profit to Gold sell'), true)
  assert.equal(looksLikeChannelManagementUpdate('Take profit of 30 pips on the sell'), true)
  assert.equal(looksLikeChannelManagementUpdate('Set TP to 2660'), true)
  assert.equal(looksLikeChannelManagementUpdate('Move take profit to 2670'), true)
})

test('looksLikeChannelManagementUpdate: TP result language is still management', () => {
  assert.equal(looksLikeChannelManagementUpdate('Take profit target hit at 2660'), true)
})

test('looksLikeChannelManagementUpdate: structured entries stay entries', () => {
  assert.equal(looksLikeChannelManagementUpdate('GOLD BUY NOW Entry 2650 SL 2640 TP 2660'), false)
  assert.equal(looksLikeChannelManagementUpdate('SELL GOLD 4276 TP 4256'), false)
})

test('partialCloseFractionFromMessage: secure 30% profits', () => {
  assert.equal(
    partialCloseFractionFromMessage('secure 30% profits by closing partial lotsize'),
    0.3,
  )
})

test('looksLikeChannelManagementUpdate: generic percent partial with plural nouns', () => {
  assert.equal(looksLikeChannelManagementUpdate('Close 20% of the trades now'), true)
  assert.equal(looksLikeChannelManagementUpdate('Close 20% of the positions now'), true)
  assert.equal(looksLikeChannelManagementUpdate('20% of the trades'), true)
})

test('partialCloseFractionFromMessage: generic percentages and plural nouns', () => {
  assert.equal(partialCloseFractionFromMessage('Close 20% of the trades now'), 0.2)
  assert.equal(partialCloseFractionFromMessage('Close 20% of the positions now'), 0.2)
  assert.equal(partialCloseFractionFromMessage('20% of the trades'), 0.2)
  assert.equal(partialCloseFractionFromMessage('Close 100% of the trades'), 1)
})

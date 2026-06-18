import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  looksLikeChannelManagementUpdate,
  looksLikeExplicitFullCloseCommand,
  partialCloseFractionFromMessage,
} from './signalManagementIntent'
import { normalizeSignalMessageForParse } from './normalizeTelegramMessageText'

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

test('partialCloseFractionFromMessage: secure 30% profits', () => {
  assert.equal(
    partialCloseFractionFromMessage('secure 30% profits by closing partial lotsize'),
    0.3,
  )
})

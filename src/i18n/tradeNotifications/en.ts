import type { TradeNotificationsTranslations } from './types'

export const tradeNotificationsEn: TradeNotificationsTranslations = {
  headlines: {
    executionCompleted: 'TRADE EXECUTION COMPLETED',
    modificationCompleted: 'TRADE MODIFICATION COMPLETED',
    layeringCompleted: 'LAYERING COMPLETED',
    tradesClosed: 'SOME TRADES CLOSED',
  },
  bodies: {
    executionBatch: '{count} {side} trades were opened in {broker} from {channel}.',
    executionSingle: 'A {side} trade was opened in {broker} from {channel}.',
    slModifiedFromTo:
      'SL was modified from {oldSl} to {newSl} on your {side} trade in {broker} from {channel}.',
    slModifiedTo: 'SL was updated to {newSl} on your {side} trade in {broker} from {channel}.',
    tpModifiedTo: 'TP was updated to {newTp} on your {side} trade in {broker} from {channel}.',
    tpsModifiedTo: 'TPs were updated to {tpList} on your {side} trade in {broker} from {channel}.',
    slAndTpsModifiedTo:
      'SL was updated to {newSl} and TPs to {tpList} on your {side} trade in {broker} from {channel}.',
    modificationBatch: '{count} trades were updated in {broker} from {channel}.',
    tpsModificationBatch: 'TPs were updated on {count} {side} trades in {broker} from {channel}.',
    layeringBatch: '{count} layered orders were filled in {broker} from {channel}.',
    layeringSingle: 'A layered order was filled in {broker} from {channel}.',
    tradesClosedTp: '{count} trades were closed in {broker} due to {reason} from {channel}.',
    tradesClosedGeneric: '{count} trades were closed in {broker} from {channel}.',
    tradesClosedSingle: 'A trade was closed in {broker} from {channel}.',
  },
  sides: {
    buy: 'buy',
    sell: 'sell',
    trade: 'trade',
  },
  fallbacks: {
    broker: 'your account',
    channel: 'your channel',
  },
  tpReason: 'TP{index}',
}

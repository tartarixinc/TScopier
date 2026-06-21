import type { TradeNotificationsTranslations } from './types'

export const tradeNotificationsEs: TradeNotificationsTranslations = {
  headlines: {
    executionCompleted: 'EJECUCIÓN DE TRADE COMPLETADA',
    modificationCompleted: 'MODIFICACIÓN DE TRADE COMPLETADA',
    layeringCompleted: 'LAYERING COMPLETADO',
    tradesClosed: 'TRADES CERRADOS',
  },
  bodies: {
    executionBatch: 'Se abrieron {count} trades {side} en {broker} desde {channel}.',
    executionSingle: 'Se abrió un trade {side} en {broker} desde {channel}.',
    slModifiedFromTo:
      'El SL cambió de {oldSl} a {newSl} en tu trade {side} en {broker} desde {channel}.',
    slModifiedTo: 'El SL se actualizó a {newSl} en tu trade {side} en {broker} desde {channel}.',
    tpModifiedTo: 'El TP se actualizó a {newTp} en tu trade {side} en {broker} desde {channel}.',
    tpsModifiedTo: 'Los TPs se actualizaron a {tpList} en tu trade {side} en {broker} desde {channel}.',
    slAndTpsModifiedTo:
      'El SL se actualizó a {newSl} y los TPs a {tpList} en tu trade {side} en {broker} desde {channel}.',
    modificationBatch: 'Se actualizaron {count} trades en {broker} desde {channel}.',
    tpsModificationBatch: 'Los TPs se actualizaron en {count} trades {side} en {broker} desde {channel}.',
    layeringBatch: 'Se ejecutaron {count} órdenes en layering en {broker} desde {channel}.',
    layeringSingle: 'Se ejecutó una orden en layering en {broker} desde {channel}.',
    tradesClosedTp: 'Se cerraron {count} trades en {broker} por {reason} desde {channel}.',
    tradesClosedGeneric: 'Se cerraron {count} trades en {broker} desde {channel}.',
    tradesClosedSingle: 'Se cerró un trade en {broker} desde {channel}.',
  },
  sides: {
    buy: 'compra',
    sell: 'venta',
    trade: 'trade',
  },
  fallbacks: {
    broker: 'tu cuenta',
    channel: 'tu canal',
  },
  tpReason: 'TP{index}',
}

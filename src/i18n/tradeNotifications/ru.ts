import type { TradeNotificationsTranslations } from './types'

export const tradeNotificationsRu: TradeNotificationsTranslations = {
  headlines: {
    executionCompleted: 'ИСПОЛНЕНИЕ СДЕЛКИ ЗАВЕРШЕНО',
    modificationCompleted: 'ИЗМЕНЕНИЕ СДЕЛКИ ЗАВЕРШЕНО',
    layeringCompleted: 'ЛЕЙЕРИНГ ЗАВЕРШЕН',
    tradesClosed: 'ЧАСТЬ СДЕЛОК ЗАКРЫТА',
  },
  bodies: {
    executionBatch: 'Открыто {count} сделок {side} на {broker} из {channel}.',
    executionSingle: 'Открыта сделка {side} на {broker} из {channel}.',
    slModifiedFromTo: 'SL изменен с {oldSl} на {newSl} в вашей сделке {side} на {broker} из {channel}.',
    slModifiedTo: 'SL обновлен до {newSl} в вашей сделке {side} на {broker} из {channel}.',
    tpModifiedTo: 'TP обновлен до {newTp} в вашей сделке {side} на {broker} из {channel}.',
    tpsModifiedTo: 'TP обновлены до {tpList} в вашей сделке {side} на {broker} из {channel}.',
    slAndTpsModifiedTo:
      'SL обновлен до {newSl}, а TP до {tpList} в вашей сделке {side} на {broker} из {channel}.',
    modificationBatch: 'Обновлено {count} сделок на {broker} из {channel}.',
    tpsModificationBatch: 'TP обновлены в {count} сделках {side} на {broker} из {channel}.',
    layeringBatch: 'Исполнено {count} многоуровневых ордеров на {broker} из {channel}.',
    layeringSingle: 'Исполнен многоуровневый ордер на {broker} из {channel}.',
    tradesClosedTp: 'Закрыто {count} сделок на {broker} по причине {reason} из {channel}.',
    tradesClosedGeneric: 'Закрыто {count} сделок на {broker} из {channel}.',
    tradesClosedSingle: 'Закрыта сделка на {broker} из {channel}.',
  },
  sides: {
    buy: 'на покупку',
    sell: 'на продажу',
    trade: 'сделке',
  },
  fallbacks: {
    broker: 'вашем счете',
    channel: 'вашего канала',
  },
  tpReason: 'TP{index}',
}

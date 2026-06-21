import type { TradeNotificationsTranslations } from './types'

export const tradeNotificationsSv: TradeNotificationsTranslations = {
  headlines: {
    executionCompleted: 'HANDELSUTFÖRANDE SLUTFÖRT',
    modificationCompleted: 'HANDELSÄNDRING SLUTFÖRD',
    layeringCompleted: 'LAYERING SLUTFÖRT',
    tradesClosed: 'VISSA AFFÄRER STÄNGDA',
  },
  bodies: {
    executionBatch: '{count} {side}-affärer öppnades i {broker} från {channel}.',
    executionSingle: 'En {side}-affär öppnades i {broker} från {channel}.',
    slModifiedFromTo: 'SL ändrades från {oldSl} till {newSl} på din {side}-affär i {broker} från {channel}.',
    slModifiedTo: 'SL uppdaterades till {newSl} på din {side}-affär i {broker} från {channel}.',
    tpModifiedTo: 'TP uppdaterades till {newTp} på din {side}-affär i {broker} från {channel}.',
    tpsModifiedTo: 'TP uppdaterades till {tpList} på din {side}-affär i {broker} från {channel}.',
    slAndTpsModifiedTo:
      'SL uppdaterades till {newSl} och TP till {tpList} på din {side}-affär i {broker} från {channel}.',
    modificationBatch: '{count} affärer uppdaterades i {broker} från {channel}.',
    tpsModificationBatch: 'TP uppdaterades på {count} {side}-affärer i {broker} från {channel}.',
    layeringBatch: '{count} lagerordrar fylldes i {broker} från {channel}.',
    layeringSingle: 'En lagerorder fylldes i {broker} från {channel}.',
    tradesClosedTp: '{count} affärer stängdes i {broker} på grund av {reason} från {channel}.',
    tradesClosedGeneric: '{count} affärer stängdes i {broker} från {channel}.',
    tradesClosedSingle: 'En affär stängdes i {broker} från {channel}.',
  },
  sides: {
    buy: 'köp',
    sell: 'sälj',
    trade: 'affär',
  },
  fallbacks: {
    broker: 'ditt konto',
    channel: 'din kanal',
  },
  tpReason: 'TP{index}',
}

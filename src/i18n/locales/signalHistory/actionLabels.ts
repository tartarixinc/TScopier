/** Localized buy/sell/management action verbs for Copier Logs + Signal History. */

export type SignalActionLabels = {
  actionBuy: string
  actionSell: string
  actionClose: string
  actionCloseWorseEntries: string
  actionBreakeven: string
  actionModify: string
  actionPartialProfit: string
  actionPartialBreakeven: string
}

export const signalActionsPl: SignalActionLabels = {
  actionBuy: 'Kupno',
  actionSell: 'Sprzedaż',
  actionClose: 'Zamknięcie',
  actionCloseWorseEntries: 'Zamknij gorsze wejścia',
  actionBreakeven: 'Przenieś SL na BE',
  actionModify: 'Aktualizuj SL/TP',
  actionPartialProfit: 'Częściowy zysk',
  actionPartialBreakeven: 'Częściowy zysk + BE',
}

export const signalActionsNl: SignalActionLabels = {
  actionBuy: 'Kopen',
  actionSell: 'Verkopen',
  actionClose: 'Sluiten',
  actionCloseWorseEntries: 'Slechtere entries sluiten',
  actionBreakeven: 'SL naar break-even',
  actionModify: 'SL/TP bijwerken',
  actionPartialProfit: 'Gedeeltelijke winst',
  actionPartialBreakeven: 'Gedeeltelijke winst + break-even',
}

export const signalActionsSv: SignalActionLabels = {
  actionBuy: 'Köp',
  actionSell: 'Sälj',
  actionClose: 'Stäng',
  actionCloseWorseEntries: 'Stäng sämre entries',
  actionBreakeven: 'Flytta SL till break-even',
  actionModify: 'Uppdatera SL/TP',
  actionPartialProfit: 'Delvinst',
  actionPartialBreakeven: 'Delvinst + break-even',
}

export const signalActionsRu: SignalActionLabels = {
  actionBuy: 'Покупка',
  actionSell: 'Продажа',
  actionClose: 'Закрытие',
  actionCloseWorseEntries: 'Закрыть худшие входы',
  actionBreakeven: 'Перенести SL на безубыток',
  actionModify: 'Обновить SL/TP',
  actionPartialProfit: 'Частичная прибыль',
  actionPartialBreakeven: 'Частичная прибыль + безубыток',
}

export const signalActionsJa: SignalActionLabels = {
  actionBuy: '買い',
  actionSell: '売り',
  actionClose: '決済',
  actionCloseWorseEntries: '不利なエントリーを決済',
  actionBreakeven: 'SLを建値へ',
  actionModify: 'SL/TPを更新',
  actionPartialProfit: '部分利確',
  actionPartialBreakeven: '部分利確 + 建値',
}

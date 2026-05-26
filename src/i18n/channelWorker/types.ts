/** User-facing Channel Worker feed messages (dashboard log lines). */
export interface ChannelWorkerTranslations {
  onOpenTrade: string
  onSymbol: string
  forSymbol: string
  errSuffix: string
  symbolExempted: string
  several: string
  all: string
  leg: string
  legs: string
  notPlaced: string
  noMatchingOpenTrade: string
  partialUpdate: string
  legsUpdated: string
  awaitingTicket: string
  brokerErrors: string
  egError: string
  lotsParen: string
  sideBuy: string
  sideSell: string
  verbBuy: string
  verbSell: string
  verbTrade: string
  priceAt: string
  slTo: string
  slAt: string
  slParen: string
  legsDetail: string

  pipelineReading: string
  pipelineUnderstood: string
  pipelineCouldNotRead: string
  keywordCouldNotUnderstand: string

  planFallbackNamed: string
  planFallbackGeneric: string

  orderDidNotPlaceNamed: string
  orderDidNotPlaceGeneric: string
  orderDidNotPlaceSkipped: string
  orderCouldNotVerb: string
  orderCouldNotPlace: string
  orderPending: string
  orderOpened: string
  orderSent: string

  virtualInsertedNamed: string
  virtualInsertedGeneric: string
  virtualFired: string
  virtualCancelled: string
  virtualExpired: string
  virtualFailedNamed: string
  virtualFailedGeneric: string

  entryPlaced: string
  entryFilled: string
  entryCancelled: string
  entryFailed: string

  mergeAddedNamed: string
  mergeAddedGeneric: string
  mergeSlTpSuccessNamed: string
  mergeSlTpSuccessGeneric: string
  mergeUserMsgNamed: string
  mergeCouldNotUpdateNamed: string
  mergeCouldNotUpdateGeneric: string
  mergeAnchorNamed: string
  mergeAnchorGeneric: string

  oppositeCloseNamed: string
  oppositeCloseGeneric: string
  partialTpFired: string
  trailingMoved: string
  trailingCouldNot: string
  autoBeHalf: string
  autoBe: string
  autoBeFailed: string
  cweCloseNamed: string
  cweCloseGeneric: string
  genericFailedNamed: string
  genericFailedGeneric: string

  understood: string
  completed: string
  signalBuyNamed: string
  signalBuyGeneric: string
  signalSellNamed: string
  signalSellGeneric: string
  signalCloseNamed: string
  signalCloseGeneric: string
  signalBreakevenUnderstood: string
  signalBreakevenCompleted: string
  signalPartialProfit: string
  signalPartialBreakeven: string
  signalModify: string
  signalIgnore: string
  signalDefault: string

  mgmtCloseSuccessNamed: string
  mgmtCloseSuccessGeneric: string
  mgmtBreakevenSuccess: string
  mgmtPartialProfit: string
  mgmtPartialBreakeven: string
  mgmtModifySuccess: string
  mgmtAppliedNamed: string
  mgmtAppliedGeneric: string

  mgmtCloseFailNamed: string
  mgmtCloseFailGeneric: string
  mgmtBreakevenFailNamed: string
  mgmtBreakevenFailGeneric: string
  mgmtPartialProfitFail: string
  mgmtPartialBreakevenFail: string
  mgmtModifyFail: string
  mgmtApplyFailNamed: string
  mgmtApplyFailGeneric: string

  mgmtCloseSkippedNamed: string
  mgmtCloseSkippedGeneric: string
  mgmtSkippedNamed: string
  mgmtSkippedGeneric: string
  mgmtSkippedReason: string

  dispatchSkipped: string

  skipReasons: Record<string, string>
  errorTicketNotFound: string
  errorSymbolNotFound: string
  errorBrokerNotConnected: string
  errorBridgeGlitch: string
  errorStopsAlreadySet: string
}

import type { BrokerFailureMode } from './brokerFailureModes'
import type { LoadScenario } from './telegramPipelineFixtures'
import { NON_HAPPY_TELEGRAM_MESSAGES } from './telegramPipelineFixtures'
import type { PipelineStage } from './pipelineOutcome'
import { TELEGRAM_GOLD_BUY_SAMPLE } from './telegramPipelineStages'

export type TelegramPipelineScenarioCase = {
  name: string
  rawMessage: string
  scenario: LoadScenario
  brokerFailure?: BrokerFailureMode
  platform?: 'MT4' | 'MT5' | 'FXSOCKET'
  expectedStage: PipelineStage
  expectedSkipReason?: string
  expectBrokerReached: boolean
  requireSkipReason?: boolean
}

export const TELEGRAM_PIPELINE_SCENARIO_CASES: TelegramPipelineScenarioCase[] = [
  {
    name: 'heuristic reject stops at telegram_received',
    rawMessage: NON_HAPPY_TELEGRAM_MESSAGES.heuristic_reject,
    scenario: 'heuristic_reject',
    expectedStage: 'telegram_received',
    expectedSkipReason: 'heuristic_rejected',
    expectBrokerReached: false,
  },
  {
    name: 'parse skip stops before parsed',
    rawMessage: NON_HAPPY_TELEGRAM_MESSAGES.parse_skip,
    scenario: 'parse_skip',
    expectedStage: 'heuristic_pass',
    expectBrokerReached: false,
  },
  {
    name: 'commentary fails eligibility',
    rawMessage: NON_HAPPY_TELEGRAM_MESSAGES.not_eligible,
    scenario: 'not_eligible',
    expectedStage: 'parsed',
    expectBrokerReached: false,
    requireSkipReason: true,
  },
  {
    name: 'FxSocket session down stops at dispatched',
    rawMessage: TELEGRAM_GOLD_BUY_SAMPLE,
    scenario: 'broker_session_down',
    brokerFailure: 'fxsocket_session_down',
    platform: 'MT5',
    expectedStage: 'dispatched',
    expectedSkipReason: 'fxsocket_session_down',
    expectBrokerReached: false,
  },
  {
    name: 'FxSocket OrderSend fail stops at dispatched',
    rawMessage: TELEGRAM_GOLD_BUY_SAMPLE,
    scenario: 'broker_order_fail',
    brokerFailure: 'fxsocket_order_send_fail',
    expectedStage: 'dispatched',
    expectedSkipReason: 'fxsocket_order_send_failed',
    expectBrokerReached: false,
  },
  {
    name: 'FxSocket WS disconnected stops at dispatched',
    rawMessage: TELEGRAM_GOLD_BUY_SAMPLE,
    scenario: 'broker_ws_down',
    brokerFailure: 'fxsocket_ws_disconnected',
    expectedStage: 'dispatched',
    expectedSkipReason: 'fxsocket_ws_disconnected',
    expectBrokerReached: false,
  },
]

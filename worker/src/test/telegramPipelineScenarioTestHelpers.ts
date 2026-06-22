import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { runTelegramPipelineTracked } from './telegramPipelineStages'
import type { TelegramPipelineScenarioCase } from './telegramPipelineScenarioCases'

function assertOptionalSkipReason(actual: string | undefined, expected: string | undefined): void {
  if (expected === undefined) return
  assert.equal(actual, expected)
}

function assertSkipReasonWhenRequired(actual: string | undefined, required?: boolean): void {
  if (!required) return
  assert.ok(actual)
}

export async function assertPipelineScenarioCases(
  t: TestContext,
  cases: TelegramPipelineScenarioCase[],
): Promise<void> {
  await cases.reduce(
    (chain, scenarioCase) => chain.then(() => t.test(scenarioCase.name, async () => {
      const outcome = await runTelegramPipelineTracked(scenarioCase.rawMessage, {
        userId: 'u1',
        signalId: 's1',
        brokerAccountId: 'b1',
        scenario: scenarioCase.scenario,
        brokerFailure: scenarioCase.brokerFailure,
        platform: scenarioCase.platform,
      })
      assert.equal(outcome.stageReached, scenarioCase.expectedStage)
      assert.equal(outcome.brokerReached, scenarioCase.expectBrokerReached)
      assertOptionalSkipReason(outcome.skipReason, scenarioCase.expectedSkipReason)
      assertSkipReasonWhenRequired(outcome.skipReason, scenarioCase.requireSkipReason)
    })),
    Promise.resolve(),
  )
}

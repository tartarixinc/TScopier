import assert from 'node:assert/strict'
import test from 'node:test'
import { SOCIAL_ELIGIBILITY_REASON_ORDER, eligibilityDiagnosticForReason, normalizeEligibilityDiagnostics, primaryEligibilityDiagnostic } from './socialEligibility'

test('every server eligibility reason has actionable, user-safe copy', () => {
  for (const reason of SOCIAL_ELIGIBILITY_REASON_ORDER) {
    const diagnostic = eligibilityDiagnosticForReason(reason)
    assert.equal(diagnostic.code, reason)
    assert.ok(diagnostic.explanation.length > 20)
    if (reason === 'eligible') assert.equal(diagnostic.nextAction, null)
    else assert.ok((diagnostic.nextAction ?? '').length > 20)
    assert.doesNotMatch(diagnostic.explanation, /password|token|service.role|stack|exception/i)
  }
})

test('orders multiple blockers and prioritizes a blocker over a pending check', () => {
  const diagnostics = normalizeEligibilityDiagnostics([
    { code: 'sync_pending', status: 'pending', severity: 'info', blocking: true, order: 8 },
    { code: 'source_unsupported', status: 'blocked', severity: 'error', blocking: true, order: 3 },
  ], 'source_missing')
  assert.deepEqual(diagnostics.map(item => item.code), ['source_unsupported', 'sync_pending'])
  assert.equal(primaryEligibilityDiagnostic(diagnostics).code, 'source_unsupported')
})

test('uses canonical fallbacks for malformed public responses', () => {
  assert.equal(normalizeEligibilityDiagnostics(null, 'history_stale')[0]?.code, 'history_stale')
  assert.equal(eligibilityDiagnosticForReason('internal_database_error').code, 'source_missing')
})

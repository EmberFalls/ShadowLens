import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, verifyRedaction, redactAndVerify, AnalysisFailure } from '../dist/index.js';
import { DEFAULT_POLICY } from '../dist/default-policy.js';

test('verification binds approved text to redaction plan and requires mixed warning acknowledgment', () => {
  const text = 'CONFIDENTIAL contact person@shop.invalid';
  const analysis = analyze({ text, policy: DEFAULT_POLICY });
  const approvedText = 'CONFIDENTIAL contact [REDACTED_PII]';
  const pending = verifyRedaction({ originalText: text, approvedText, analysis, policy: DEFAULT_POLICY });
  assert.equal(pending.safe, false);
  assert.equal(pending.requiresWarnAcknowledgement, true);
  const acknowledged = verifyRedaction({ originalText: text, approvedText, analysis, policy: DEFAULT_POLICY, warnAcknowledged: true });
  assert.equal(acknowledged.safe, true);
  assert.throws(() => verifyRedaction({ originalText: text, approvedText: 'different content', analysis, policy: DEFAULT_POLICY }), error => error instanceof AnalysisFailure && error.code === 'INVALID_OFFSETS');
});

test('standalone confidentiality marker is never blindly replaced', () => {
  const text = 'CONFIDENTIAL';
  const result = analyze({ text, policy: DEFAULT_POLICY });
  assert.equal(result.decision.action, 'WARN');
  assert.deepEqual(result.decision.replacementOperations, []);
  assert.throws(() => redactAndVerify({ text, policy: DEFAULT_POLICY }), error => error instanceof AnalysisFailure);
  const acknowledged = redactAndVerify({ text, policy: DEFAULT_POLICY, warnAcknowledged: true });
  assert.equal(acknowledged.approvedText, text);
  assert.equal(acknowledged.verification.safe, true);
  const lockedPolicy = { ...DEFAULT_POLICY, allowWarnOverride: false };
  const lockedAnalysis = analyze({ text, policy: lockedPolicy });
  const locked = verifyRedaction({ originalText: text, approvedText: text, analysis: lockedAnalysis, policy: lockedPolicy, warnAcknowledged: true });
  assert.equal(locked.safe, false);
});

test('malformed replacement spans fail closed', () => {
  assert.throws(() => verifyRedaction({ originalText: 'abc', approvedText: 'abc', analysis: { detection: { inputLength: 3 }, decision: {} }, policy: DEFAULT_POLICY }), error => error instanceof AnalysisFailure);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, applyRedaction, planRedaction, verifyRedaction, AnalysisFailure } from '../dist/index.js';
import { DEFAULT_POLICY } from '../dist/default-policy.js';

test('redaction preserves source text around repeated values and stays descending/non-overlapping', () => {
  const value = 'person@shop.invalid';
  const text = `🙂 first ${value}; second ${value} end`;
  const analysis = analyze({ text, policy: DEFAULT_POLICY });
  const operations = planRedaction({ text, findings: analysis.detection.findings });
  assert.equal(operations.length, 2);
  assert.ok(operations[0].start > operations[1].start);
  assert.ok(operations[1].end <= operations[0].start);
  const approvedText = applyRedaction({ text, operations });
  assert.equal(approvedText, '🙂 first [REDACTED_PII]; second [REDACTED_PII] end');
  assert.equal(verifyRedaction({ originalText: text, approvedText, analysis, policy: DEFAULT_POLICY }).safe, true);
});

test('out-of-range and overlapping application operations fail closed', () => {
  assert.throws(() => applyRedaction({ text: 'abc', operations: [{ start: 2, end: 4, replacement: '[REDACTED_PII]', category: 'PII_EMAIL' }] }), error => error instanceof AnalysisFailure && error.code === 'INVALID_OFFSETS');
  assert.throws(() => applyRedaction({ text: 'abcdef', operations: [
    { start: 3, end: 5, replacement: '[REDACTED_PII]', category: 'PII_EMAIL' },
    { start: 2, end: 4, replacement: '[REDACTED_PII]', category: 'PII_EMAIL' },
  ] }), error => error instanceof AnalysisFailure && error.code === 'INVALID_OFFSETS');
});

test('post-redaction verification rejects changed approved text that introduces a new finding', () => {
  const text = 'contact person@shop.invalid';
  const analysis = analyze({ text, policy: DEFAULT_POLICY });
  const injected = 'contact [REDACTED_PII] plus other@shop.invalid';
  assert.throws(() => verifyRedaction({ originalText: text, approvedText: injected, analysis, policy: DEFAULT_POLICY }), error => error instanceof AnalysisFailure && error.code === 'INVALID_OFFSETS');
});

test('large contact CSV is redacted by exact spans and requires mixed warn acknowledgment', () => {
  const text = ['name,email,phone', ...Array.from({ length: 500 }, (_, i) => `Person${i},p${i}@shop.invalid,98765${String(i).padStart(5, '0')}`)].join('\n');
  const analysis = analyze({ text, policy: DEFAULT_POLICY });
  assert.equal(analysis.decision.action, 'REDACT');
  assert.equal(analysis.decision.requiresWarnAcknowledgement, true);
  const approvedText = applyRedaction({ text, operations: analysis.decision.replacementOperations });
  const verification = verifyRedaction({ originalText: text, approvedText, analysis, policy: DEFAULT_POLICY, warnAcknowledged: true });
  assert.equal(verification.safe, true);
  assert.equal(verification.residualFindings.length, 0);
});

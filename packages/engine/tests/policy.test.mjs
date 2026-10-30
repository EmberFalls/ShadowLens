import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePolicy, validatePolicy, effectiveActionForFinding } from '../dist/policy.js';
import { DEFAULT_POLICY } from '../dist/default-policy.js';
import { AnalysisFailure } from '../dist/types-internal.js';

const finding = (category, severity = 'HIGH', replaceable = true) => ({ id: 'f1', ruleId: 'test', category, severity, start: 0, end: 4, confidenceHint: 'HIGH', replaceable, explanationCode: 'EXPLAIN_CONTACT_EMAIL' });

test('permutation of policy rules does not change strongest action', () => {
  const detection = { findings: [finding('PII_EMAIL')], score: 30, tier: 'MEDIUM' };
  const first = evaluatePolicy({ detection, policy: DEFAULT_POLICY });
  const second = evaluatePolicy({ detection, policy: { ...DEFAULT_POLICY, rules: [...DEFAULT_POLICY.rules].reverse() } });
  assert.equal(first.action, 'REDACT');
  assert.equal(second.action, 'REDACT');
  assert.deepEqual(first.matchedRuleIds, second.matchedRuleIds);
});

test('shared per-finding action keeps residual verification aligned with rule precedence', () => {
  const findingToCheck = finding('PII_EMAIL');
  const policy = { ...DEFAULT_POLICY, rules: [
    { id: 'test.allow', category: 'PII_EMAIL', minimumSeverity: 'LOW', action: 'ALLOW', enabled: true },
    { id: 'test.redact', category: '*', minimumSeverity: 'MEDIUM', action: 'REDACT', enabled: true },
    ...DEFAULT_POLICY.rules.filter(rule => rule.category === 'SECRET_PRIVATE_KEY'),
  ] };
  assert.equal(effectiveActionForFinding(findingToCheck, policy), 'REDACT');
});

test('explicit ALLOW is honored but private-key hard block cannot be removed', () => {
  const policy = { ...DEFAULT_POLICY, rules: [...DEFAULT_POLICY.rules.filter(rule => rule.category !== 'PII_EMAIL'), { id: 'owner.allow.email', category: 'PII_EMAIL', minimumSeverity: 'LOW', action: 'ALLOW', enabled: true }] };
  assert.equal(evaluatePolicy({ detection: { findings: [finding('PII_EMAIL')], score: 1, tier: 'LOW' }, policy }).action, 'ALLOW');
  assert.throws(() => validatePolicy({ ...DEFAULT_POLICY, rules: DEFAULT_POLICY.rules.filter(rule => rule.category !== 'SECRET_PRIVATE_KEY') }), error => error instanceof AnalysisFailure && error.code === 'INVALID_POLICY');
});

test('unrecognized internal categories receive the configured fallback', () => {
  const unknown = finding('INTERNAL_UNREGISTERED_CATEGORY');
  const result = evaluatePolicy({ detection: { findings: [unknown], score: 0, tier: 'NONE' }, policy: DEFAULT_POLICY });
  assert.equal(result.action, 'WARN');
  assert.ok(result.reasonCodes.includes('POLICY_FALLBACK_WARN'));
});

test('nonreplaceable REDACT becomes BLOCK and severity boundaries use fallback', () => {
  const markerPolicy = { ...DEFAULT_POLICY, rules: [...DEFAULT_POLICY.rules, { id: 'marker.redact', category: 'CONFIDENTIAL_MARKER', minimumSeverity: 'HIGH', action: 'REDACT', enabled: true }] };
  const blocked = evaluatePolicy({ detection: { findings: [finding('CONFIDENTIAL_MARKER', 'HIGH', false)], score: 1, tier: 'LOW' }, policy: markerPolicy });
  assert.equal(blocked.action, 'BLOCK');
  const belowBoundary = evaluatePolicy({ detection: { findings: [finding('PII_EMAIL', 'LOW')], score: 1, tier: 'LOW' }, policy: DEFAULT_POLICY });
  assert.equal(belowBoundary.action, 'WARN');
});

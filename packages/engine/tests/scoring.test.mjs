import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreFindings } from '../dist/scoring.js';

const finding = (id, start, severity = 'MEDIUM') => ({ id, ruleId: 'PII.EMAIL', category: 'PII_EMAIL', severity, start, end: start + 12, confidenceHint: 'HIGH', replaceable: true, explanationCode: 'EXPLAIN_CONTACT_EMAIL' });

test('scoring has fixed expected values and stable ordering', () => {
  assert.deepEqual(scoreFindings([]), { score: 0, tier: 'NONE', highestSeverity: null, categoryCounts: {}, reasonCodes: [] });
  const one = finding('one', 0);
  assert.deepEqual(scoreFindings([one]), {
    score: 12, tier: 'LOW', highestSeverity: 'MEDIUM', categoryCounts: { PII_EMAIL: 1 }, reasonCodes: ['DETECTED_PII'],
  });
  const contacts = Array.from({ length: 500 }, (_, index) => finding(`f${index}`, index * 13));
  const forward = scoreFindings(contacts);
  const reverse = scoreFindings([...contacts].reverse());
  assert.equal(forward.score, 56);
  assert.equal(forward.tier, 'HIGH');
  assert.equal(forward.categoryCounts.PII_EMAIL, 500);
  assert.equal(forward.categoryCounts.BULK_CONTACT_LIST, 1);
  assert.deepEqual(forward, reverse);
});

test('same-start findings score deterministically without mutating the input', () => {
  const email = finding('email', 0, 'MEDIUM');
  const phone = { ...finding('phone', 0, 'HIGH'), category: 'PII_PHONE', ruleId: 'PII.INDIA_MOBILE', explanationCode: 'EXPLAIN_CONTACT_PHONE' };
  const input = [email, phone];
  const before = structuredClone(input);
  const first = scoreFindings(input);
  assert.deepEqual(scoreFindings([...input].reverse()), first);
  assert.deepEqual(input, before);
});

test('aggregate score tier does not replace highest finding severity', () => {
  const categories = ['PII_EMAIL','PII_PHONE','PII_PAYMENT_CARD','PII_AADHAAR','PII_INDIA_PAN','PII_GSTIN','PII_IFSC','PII_UPI','SECRET_TOKEN','SECRET_PRIVATE_KEY','CONFIDENTIAL_MARKER','SOURCE_CODE_CONTEXT','CUSTOM_PROTECTED_TERM'];
  const findings = categories.map((category, index) => ({ ...finding(`f${index}`, index * 13, 'LOW'), category, replaceable: category !== 'SECRET_PRIVATE_KEY' }));
  const result = scoreFindings(findings);
  assert.equal(result.score, 100);
  assert.equal(result.tier, 'CRITICAL');
  assert.equal(result.highestSeverity, 'LOW');
});

test('score remains bounded at 100 for extreme internally supplied findings', () => {
  const findings = Array.from({ length: 1000 }, (_, index) => ({ ...finding(`f${index}`, index), category: 'SECRET_PRIVATE_KEY', severity: 'CRITICAL', replaceable: false, ruleId: 'SECRET.PEM_PRIVATE_KEY', explanationCode: 'EXPLAIN_PRIVATE_KEY' }));
  const result = scoreFindings(findings);
  assert.equal(result.score, 100);
  assert.equal(result.tier, 'CRITICAL');
  assert.equal(result.highestSeverity, 'CRITICAL');
});

test('bulk escalation counts email and phone entities together', () => {
  const phones = Array.from({ length: 2 }, (_, index) => ({ ...finding(`p${index}`, 100 + index * 20), category: 'PII_PHONE', ruleId: 'PII.INDIA_MOBILE', explanationCode: 'EXPLAIN_CONTACT_PHONE' }));
  const emails = Array.from({ length: 3 }, (_, index) => finding(`e${index}`, index * 20));
  const result = scoreFindings([...emails, ...phones]);
  assert.equal(result.categoryCounts.BULK_CONTACT_LIST, 1);
  assert.ok(result.reasonCodes.includes('DETECTED_BULK'));
});

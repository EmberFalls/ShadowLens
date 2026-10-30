import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, scanText, planRedaction, applyRedaction, AnalysisFailure } from '../dist/index.js';
import { DEFAULT_POLICY } from '../dist/default-policy.js';
import { scoreFindings } from '../dist/scoring.js';
import { evaluatePolicy } from '../dist/policy.js';

test('recognizes reserved .invalid email and returns original UTF-16 offsets', () => {
  const text = '🙂 owner: person@shop.invalid';
  const finding = scanText(text).find(item => item.category === 'PII_EMAIL');
  assert.ok(finding);
  assert.equal(text.slice(finding.start, finding.end), 'person@shop.invalid');
});

test('validated card redacts and private key blocks without redacting the envelope', () => {
  const cardText = 'card 4111 1111 1111 1111';
  const card = analyze({ text: cardText, policy: DEFAULT_POLICY });
  assert.equal(card.decision.action, 'REDACT');
  const safe = applyRedaction({ text: cardText, operations: card.decision.replacementOperations });
  assert.equal(safe, 'card [REDACTED_PII]');
  const key = analyze({ text: '-----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----', policy: DEFAULT_POLICY });
  assert.equal(key.decision.action, 'BLOCK');
  assert.deepEqual(key.decision.replacementOperations, []);
});

test('mixed replaceable PII and nonreplaceable confidentiality marker requires acknowledgment', () => {
  const result = analyze({ text: 'CONFIDENTIAL contact person@shop.invalid', policy: DEFAULT_POLICY });
  assert.equal(result.decision.action, 'REDACT');
  assert.equal(result.decision.requiresWarnAcknowledgement, true);
});

test('oversized scans fail with a typed failure', () => {
  assert.throws(() => scanText('x'.repeat(250001)), error => error instanceof AnalysisFailure && error.code === 'INPUT_TOO_LONG');
});

test('score counts repeated emails as bulk without mutating caller findings', () => {
  const findings = scanText(Array.from({ length: 6 }, (_, i) => `p${i}@shop.invalid`).join(', '));
  const result = analyze({ text: Array.from({ length: 6 }, (_, i) => `p${i}@shop.invalid`).join(', '), policy: DEFAULT_POLICY });
  assert.equal(result.detection.categoryCounts.BULK_CONTACT_LIST, 1);
  assert.equal(findings.filter(f => f.category === 'PII_EMAIL').length, 6);
});

test('contextual Indian identifiers and UPI handles are separated from email addresses', () => {
  const text = 'PAN: ABCDE1234F IFSC: HDFC0001234 pay rhea@okaxis; UPI: ari@somebank; ordinary user@corp; email rhea@example.invalid';
  const findings = scanText(text);
  assert.ok(findings.some(f => f.category === 'PII_INDIA_PAN' && text.slice(f.start, f.end) === 'ABCDE1234F'));
  assert.ok(findings.some(f => f.category === 'PII_IFSC' && text.slice(f.start, f.end) === 'HDFC0001234'));
  assert.ok(findings.some(f => f.category === 'PII_UPI' && text.slice(f.start, f.end) === 'rhea@okaxis'));
  assert.ok(findings.some(f => f.category === 'PII_UPI' && text.slice(f.start, f.end) === 'ari@somebank'));
  assert.ok(!findings.some(f => f.category === 'PII_UPI' && text.slice(f.start, f.end) === 'user@corp'));
  assert.ok(findings.some(f => f.category === 'PII_EMAIL' && text.slice(f.start, f.end) === 'rhea@example.invalid'));
});

test('policy uses highest individual severity and fails closed for an unmatched finding', () => {
  const email = scanText('owner person@shop.invalid')[0];
  const scored = scoreFindings([email]);
  const fallbackPolicy = { ...DEFAULT_POLICY, rules: DEFAULT_POLICY.rules.filter(rule => rule.category === 'SECRET_PRIVATE_KEY') };
  const decision = evaluatePolicy({ detection: { findings: [email], score: scored.score, tier: scored.tier }, policy: fallbackPolicy });
  assert.equal(decision.action, 'WARN');
  assert.equal(decision.requiresWarnAcknowledgement, true);
  assert.ok(decision.reasonCodes.includes('POLICY_FALLBACK_WARN'));
});

test('unmatched finding keeps its fallback warning when another finding requests redaction', () => {
  const email = scanText('person@shop.invalid').find(f => f.category === 'PII_EMAIL');
  const unknown = { ...email, id: 'unmatched', category: 'CUSTOM_PROTECTED_TERM', severity: 'HIGH', replaceable: false, ruleId: 'INTERNAL.UNMATCHED' };
  const scored = scoreFindings([email, unknown]);
  const decision = evaluatePolicy({ detection: { findings: [email, unknown], score: scored.score, tier: scored.tier }, policy: DEFAULT_POLICY });
  assert.equal(decision.action, 'REDACT');
  assert.equal(decision.requiresWarnAcknowledgement, true);
  assert.ok(decision.reasonCodes.includes('POLICY_FALLBACK_WARN'));
});

test('replacement operations merge overlaps and apply right to left', () => {
  const text = 'person@shop.invalid';
  const findings = scanText(text);
  const ops = planRedaction({ text, findings: [...findings, { ...findings[0], id: 'overlap', start: 2, end: 8 }] });
  assert.equal(ops.length, 1);
  assert.equal(applyRedaction({ text, operations: ops }), '[REDACTED_PII]');
});

test('analysis validates malformed hard-block policy before processing text', () => {
  const invalidPolicy = { ...DEFAULT_POLICY, rules: DEFAULT_POLICY.rules.map(rule => rule.id === 'POLICY.PRIVATE_KEY' ? { ...rule, enabled: false } : rule) };
  assert.throws(() => analyze({ text: 'benign', policy: invalidPolicy }), error => error instanceof AnalysisFailure && error.code === 'INVALID_POLICY');
});

test('PAN matches are contextual while malformed state code GSTINs are ignored', () => {
  const text = 'ABCDE1234F and PAN: PQRSX6789K; invalid GSTIN 99ABCDE1234F1Z5';
  const findings = scanText(text);
  const pan = findings.filter(f => f.category === 'PII_INDIA_PAN');
  assert.equal(pan.length, 2);
  assert.equal(pan[0].severity, 'MEDIUM');
  assert.equal(pan[1].severity, 'HIGH');
  assert.equal(findings.some(f => f.category === 'PII_GSTIN'), false);
});

test('incomplete private key envelope is detected as a nonreplaceable blocker', () => {
  const text = '-----BEGIN PRIVATE KEY-----\nfake-only-material';
  const finding = scanText(text).find(f => f.category === 'SECRET_PRIVATE_KEY');
  assert.ok(finding);
  assert.equal(finding.replaceable, false);
  assert.equal(text.slice(finding.start, finding.end), text);
  assert.ok(scanText('-----BEGIN ENCRYPTED PRIVATE KEY-----fake').some(item => item.category === 'SECRET_PRIVATE_KEY'));
});

test('large contact lists trigger bulk category and high ordinal risk', () => {
  const text = ['name,email,phone', ...Array.from({ length: 500 }, (_, i) => `Person${i},p${i}@shop.invalid,98765${String(i).padStart(5, '0')}`)].join('\n');
  const result = analyze({ text, policy: DEFAULT_POLICY });
  assert.equal(result.detection.categoryCounts.BULK_CONTACT_LIST, 1);
  assert.ok(['HIGH', 'CRITICAL'].includes(result.detection.aggregateTier));
  assert.equal(result.detection.scanCompleteness, 'FULL');
});

test('fullwidth address characters normalize but redaction keeps original spans', () => {
  const text = 'contact person＠shop.invalid';
  const result = analyze({ text, policy: DEFAULT_POLICY });
  const email = result.detection.findings.find(f => f.category === 'PII_EMAIL');
  assert.ok(email);
  assert.equal(text.slice(email.start, email.end), 'person＠shop.invalid');
  assert.equal(applyRedaction({ text, operations: planRedaction({ text, findings: [email] }) }), 'contact [REDACTED_PII]');
});

test('Aadhaar uses Verhoeff validation and rejects neighboring invalid checksums', () => {
  assert.equal(scanText('synthetic Aadhaar 123456789010').some(f => f.category === 'PII_AADHAAR'), true);
  assert.equal(scanText('synthetic Aadhaar 123456789011').some(f => f.category === 'PII_AADHAAR'), false);
});

test('scan bounds reject excessive finding counts instead of truncating', () => {
  const many = Array.from({ length: 10001 }, (_, i) => `u${i}@shop.invalid`).join(' ');
  assert.throws(() => scanText(many), error => error instanceof AnalysisFailure && error.code === 'SCANNER_TIMEOUT');
});

test('normalized mapping preserves surrogate pairs and zero-width offsets', () => {
  const text = '🙂 p\u200Berson＠shop.invalid';
  const finding = scanText(text).find(f => f.category === 'PII_EMAIL');
  assert.ok(finding);
  assert.equal(text.slice(finding.start, finding.end), 'p\u200Berson＠shop.invalid');
});

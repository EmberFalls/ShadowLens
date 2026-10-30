import test from 'node:test';
import assert from 'node:assert/strict';
import { scanText } from '../dist/index.js';

test('normalizes zero-width and fullwidth email characters while preserving original span', () => {
  for (const address of ['p\u200Berson＠shop.invalid', 'ｐｅｒｓｏｎ@shop.invalid']) {
    const text = `contact ${address}`;
    const finding = scanText(text).find(item => item.category === 'PII_EMAIL');
    assert.ok(finding);
    assert.equal(text.slice(finding.start, finding.end), address);
  }
});

test('accepts reserved .invalid addresses and rejects obvious numeric false positives', () => {
  const text = 'person@shop.invalid 1234567890 0000000000';
  const findings = scanText(text);
  assert.equal(findings.filter(item => item.category === 'PII_EMAIL').length, 1);
  assert.equal(findings.filter(item => item.category === 'PII_PHONE').length, 0);
});

test('exact dummy values are excluded but credible test-looking secrets are retained', () => {
  const fake = scanText('api_key=NOT_A_REAL_KEY');
  assert.equal(fake.some(item => item.category === 'SECRET_TOKEN'), false);
  assert.equal(scanText('api_key=FAKEKEY').some(item => item.category === 'SECRET_TOKEN'), false);
  assert.equal(scanText('api_key=').some(item => item.category === 'SECRET_TOKEN'), false);
  const shortAssignment = scanText('password=foo').find(item => item.category === 'SECRET_TOKEN');
  assert.ok(shortAssignment);
  const credible = 'api_key=sk_test_1234567890abcdef';
  const finding = scanText(credible).find(item => item.category === 'SECRET_TOKEN');
  assert.ok(finding);
  assert.equal(credible.slice(finding.start, finding.end), 'sk_test_1234567890abcdef');
});

test('detects Slack tokens, JWT-shaped secrets, environment assignments and credentialed DB URIs', () => {
  const text = 'SLACK=xoxb-12345678901234567890; API_TOKEN=abcdef123456; uri=postgres://user:pass@db.invalid/app; jwt=eyJabcdefgh.abcdefgh.abcdefgh';
  const findings = scanText(text).filter(item => item.category === 'SECRET_TOKEN');
  assert.ok(findings.length >= 4);
});

test('chunk overlap deduplicates a token spanning a scan-window boundary', () => {
  const value = 'sk_test_1234567890abcdef';
  const text = `${' '.repeat(8180)}${value}`;
  const hits = scanText(text).filter(item => item.category === 'SECRET_TOKEN');
  assert.equal(hits.length, 1);
  assert.equal(text.slice(hits[0].start, hits[0].end), value);
});

test('bounded whole-input secret scanning detects a long token crossing chunk windows', () => {
  const value = `sk_test_${'a'.repeat(900)}`;
  const text = `${' '.repeat(8180)}${value}`;
  const hits = scanText(text).filter(item => item.category === 'SECRET_TOKEN');
  assert.equal(hits.length, 1);
  assert.equal(text.slice(hits[0].start, hits[0].end), value);
});

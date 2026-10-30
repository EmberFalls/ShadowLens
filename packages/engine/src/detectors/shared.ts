import type { Category, ExplanationCode, Finding, RuleId, Severity } from '../types-internal.js';
import { AnalysisFailure } from '../types-internal.js';
import { mapNormalizedSpan, type NormalizedText } from '../normalize.js';

export type DetectorContext = { source: string; map: NormalizedText; findings: Finding[]; seen: Set<string> };

const metadata: Record<Category, { severity: Severity; replaceable: boolean; explanation: ExplanationCode; rule: RuleId }> = {
  PII_EMAIL: { severity: 'MEDIUM', replaceable: true, explanation: 'EXPLAIN_CONTACT_EMAIL', rule: 'PII.EMAIL' },
  PII_PHONE: { severity: 'MEDIUM', replaceable: true, explanation: 'EXPLAIN_CONTACT_PHONE', rule: 'PII.INDIA_MOBILE' },
  PII_PAYMENT_CARD: { severity: 'HIGH', replaceable: true, explanation: 'EXPLAIN_PAYMENT_CARD', rule: 'PII.PAYMENT_CARD' },
  PII_AADHAAR: { severity: 'HIGH', replaceable: true, explanation: 'EXPLAIN_AADHAAR', rule: 'PII.AADHAAR' },
  PII_INDIA_PAN: { severity: 'HIGH', replaceable: true, explanation: 'EXPLAIN_INDIA_PAN', rule: 'PII.INDIA_PAN' },
  PII_GSTIN: { severity: 'MEDIUM', replaceable: true, explanation: 'EXPLAIN_GSTIN', rule: 'PII.GSTIN' },
  PII_IFSC: { severity: 'LOW', replaceable: true, explanation: 'EXPLAIN_IFSC', rule: 'PII.IFSC' },
  PII_UPI: { severity: 'MEDIUM', replaceable: true, explanation: 'EXPLAIN_UPI', rule: 'PII.UPI' },
  SECRET_TOKEN: { severity: 'HIGH', replaceable: true, explanation: 'EXPLAIN_PROVIDER_TOKEN', rule: 'SECRET.TOKEN' },
  SECRET_PRIVATE_KEY: { severity: 'CRITICAL', replaceable: false, explanation: 'EXPLAIN_PRIVATE_KEY', rule: 'SECRET.PEM_PRIVATE_KEY' },
  CONFIDENTIAL_MARKER: { severity: 'HIGH', replaceable: false, explanation: 'EXPLAIN_CONFIDENTIAL_MARKER', rule: 'CONFIDENTIAL.MARKER' },
  SOURCE_CODE_CONTEXT: { severity: 'MEDIUM', replaceable: false, explanation: 'EXPLAIN_SOURCE_CODE', rule: 'CODE.STRUCTURE' },
  CUSTOM_PROTECTED_TERM: { severity: 'HIGH', replaceable: false, explanation: 'EXPLAIN_CUSTOM_PROTECTED_TERM', rule: 'CONFIDENTIAL.CUSTOM_TERM' },
  BULK_CONTACT_LIST: { severity: 'HIGH', replaceable: false, explanation: 'EXPLAIN_BULK_CONTACT_LIST', rule: 'PII.BULK_CONTACT_LIST' },
};

export function addFinding(context: DetectorContext, category: Category, start: number, end: number, confidence: 'LOW' | 'MEDIUM' | 'HIGH' = 'HIGH', severity?: Severity): void {
  const [originalStart, originalEnd] = mapNormalizedSpan(context.map, start, end);
  if (originalEnd <= originalStart) return;
  const key = `${category}:${originalStart}:${originalEnd}`;
  if (context.seen.has(key)) return;
  context.seen.add(key);
  const item = metadata[category];
  context.findings.push({ id: `f${context.findings.length + 1}`, ruleId: item.rule, category, severity: severity ?? item.severity, start: originalStart, end: originalEnd, confidenceHint: confidence, replaceable: item.replaceable, explanationCode: item.explanation });
  assertFindingBound(context.findings);
}

export function assertFindingBound(findings: readonly Finding[]): void {
  if (findings.length > 10_000) throw new AnalysisFailure('SCANNER_TIMEOUT');
}

import type { Category, Finding, ReasonCode, RiskTier, ScoreResult, Severity, TextStats } from './types-internal.js';

const severityMultiplier: Record<Severity, number> = { LOW: 1, MEDIUM: 1.5, HIGH: 2, CRITICAL: 3 };
const weight: Record<Category, number> = { PII_EMAIL: 8, PII_PHONE: 8, PII_PAYMENT_CARD: 15, PII_AADHAAR: 15, PII_INDIA_PAN: 12, PII_GSTIN: 7, PII_IFSC: 4, PII_UPI: 7, SECRET_TOKEN: 18, SECRET_PRIVATE_KEY: 35, CONFIDENTIAL_MARKER: 12, SOURCE_CODE_CONTEXT: 8, CUSTOM_PROTECTED_TERM: 12, BULK_CONTACT_LIST: 20 };
const severityRank: Record<Severity, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
function tier(score: number): RiskTier { return score === 0 ? 'NONE' : score < 25 ? 'LOW' : score < 50 ? 'MEDIUM' : score < 80 ? 'HIGH' : 'CRITICAL'; }

export function scoreFindings(findings: readonly Finding[], textStats: TextStats = {}): ScoreResult {
  const counts: Partial<Record<Category, number>> = {};
  const distinct = new Set<Category>();
  let raw = 0;
  for (const finding of findings) {
    counts[finding.category] = (counts[finding.category] ?? 0) + 1;
    if (finding.category !== 'BULK_CONTACT_LIST') distinct.add(finding.category);
  }
  const contactCount = (counts.PII_EMAIL ?? 0) + (counts.PII_PHONE ?? 0);
  let hasBulk = (textStats.uniqueContactCount ?? 0) >= 5 || contactCount >= 5 || textStats.contactCsv === true || (counts.BULK_CONTACT_LIST ?? 0) > 0;
  for (const category of [...distinct].sort()) {
    const count = counts[category]!;
    const categoryFindings = findings.filter(f => f.category === category).sort((a, b) => severityRank[b.severity] - severityRank[a.severity] || a.start - b.start || a.end - b.end);
    raw += categoryFindings.slice(0, 3).reduce((sum, f) => sum + weight[category] * severityMultiplier[f.severity], 0);
    if (count >= 5 && (category === 'PII_EMAIL' || category === 'PII_PHONE')) hasBulk = true;
  }
  if (hasBulk) { counts.BULK_CONTACT_LIST = Math.max(counts.BULK_CONTACT_LIST ?? 0, 1); raw += 20; }
  const stableCounts: Partial<Record<Category, number>> = {};
  for (const category of Object.keys(counts).sort() as Category[]) stableCounts[category] = counts[category];
  raw += Math.min(10, Math.max(0, 5 * (distinct.size - 1)));
  const score = Math.min(100, Math.round(raw));
  const highest = findings.reduce<Severity | null>((max, f) => !max || severityRank[f.severity] > severityRank[max] ? f.severity : max, null);
  const reasons: ReasonCode[] = [];
  if (Object.keys(stableCounts).some(c => c.startsWith('PII_'))) reasons.push('DETECTED_PII');
  if (Object.keys(stableCounts).some(c => c.startsWith('SECRET_'))) reasons.push('DETECTED_SECRET');
  if (stableCounts.CONFIDENTIAL_MARKER) reasons.push('DETECTED_CONFIDENTIAL');
  if (stableCounts.SOURCE_CODE_CONTEXT) reasons.push('DETECTED_SOURCE_CODE');
  if (stableCounts.BULK_CONTACT_LIST) reasons.push('DETECTED_BULK');
  if (stableCounts.CUSTOM_PROTECTED_TERM) reasons.push('DETECTED_CUSTOM_TERM');
  return { score, tier: tier(score), highestSeverity: highest, categoryCounts: stableCounts, reasonCodes: reasons };
}

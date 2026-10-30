import { AnalysisFailure, type AnalysisInput, type AnalysisOutput, type DetectionResult, type Finding } from './types-internal.js';
import { scanText } from './detectors/index.js';
import { scoreFindings } from './scoring.js';
import { evaluatePolicy } from './policy.js';
import { planRedaction } from './redaction.js';
export * from './types-internal.js';
export { scanText } from './detectors/index.js';
export { scoreFindings } from './scoring.js';
export { evaluatePolicy, validatePolicy, effectiveActionForFinding } from './policy.js';
export { planRedaction, applyRedaction, verifyRedaction, redactAndVerify } from './redaction.js';
export { normalizeWithMap, mapNormalizedSpan } from './normalize.js';
export { chunks, MAX_INPUT_UNITS } from './chunk.js';

export function analyze(input: AnalysisInput): AnalysisOutput {
  try {
    const findings: Finding[] = scanText(input.text, input.customTerms);
    const score = scoreFindings(findings, { uniqueContactCount: findings.filter(f => ['PII_EMAIL','PII_PHONE'].includes(f.category)).length, contactCsv: findings.some(f => f.category === 'BULK_CONTACT_LIST') });
    const detection: DetectionResult = { contractVersion:'v2', engineVersion:'0.1.0', inputLength:input.text.length, findings, categoryCounts:score.categoryCounts, highestFindingSeverity:score.highestSeverity, aggregateScore:score.score, aggregateTier:score.tier, scanCompleteness:'FULL' };
    const decision = evaluatePolicy({ detection:{ findings, score:score.score, tier:score.tier }, policy:input.policy });
    decision.reasonCodes = [...new Set([...score.reasonCodes, ...decision.reasonCodes])].slice(0,8);
    if(decision.action==='REDACT') decision.replacementOperations=planRedaction({text:input.text,findings});
    return { detection, decision };
  } catch (error) {
    if(error instanceof AnalysisFailure) throw error;
    throw new AnalysisFailure('ENGINE_FAILURE');
  }
}

import { AnalysisFailure, type AnalysisInput, type AnalysisOutput, type Category, type Finding, type ReplacementOperation, type VerifyRedactionInput, type VerifyRedactionOutput } from './types-internal.js';
import { analyze } from './index.js';
import { effectiveActionForFinding } from './policy.js';

const severityRank = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 } as const;
const token = (category: Category): string => category.startsWith('SECRET_') ? '[REDACTED_SECRET]' : '[REDACTED_PII]';

export function planRedaction(input: { text: string; findings: readonly Finding[] }): ReplacementOperation[] {
  const candidates = input.findings.filter(f => f.replaceable).map(f => {
    if (!Number.isInteger(f.start) || !Number.isInteger(f.end) || f.start < 0 || f.end <= f.start || f.end > input.text.length) throw new AnalysisFailure('INVALID_OFFSETS');
    return { start: f.start, end: f.end, category: f.category, severity: f.severity };
  }).sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: typeof candidates = [];
  for (const current of candidates) {
    const last = merged.at(-1);
    if (!last || current.start >= last.end) merged.push({ ...current });
    else { last.end = Math.max(last.end, current.end); if (severityRank[current.severity] > severityRank[last.severity]) { last.category = current.category; last.severity = current.severity; } }
  }
  return merged.sort((a, b) => b.start - a.start).map(({ start, end, category }) => ({ start, end, replacement: token(category), category }));
}

export function applyRedaction(input: { text: string; operations: readonly ReplacementOperation[] }): string {
  let previousStart = input.text.length + 1;
  let output = input.text;
  for (const op of input.operations) {
    if (!Number.isInteger(op.start) || !Number.isInteger(op.end) || op.start < 0 || op.end <= op.start || op.end > input.text.length || op.end > previousStart || !/^\[REDACTED_(?:PII|SECRET)\]$/.test(op.replacement)) throw new AnalysisFailure('INVALID_OFFSETS');
    output = output.slice(0, op.start) + op.replacement + output.slice(op.end);
    previousStart = op.start;
  }
  return output;
}

export function verifyRedaction(input: VerifyRedactionInput): VerifyRedactionOutput {
  const original = analyze({ text: input.originalText, policy: input.policy, customTerms: input.customTerms });
  if (input.analysis.detection.inputLength !== input.originalText.length || JSON.stringify(original) !== JSON.stringify(input.analysis)) throw new AnalysisFailure('INVALID_OFFSETS');
  if (original.decision.action === 'BLOCK') throw new AnalysisFailure('ENGINE_FAILURE');
  const expectedApprovedText = original.decision.action === 'REDACT'
    ? applyRedaction({ text: input.originalText, operations: original.decision.replacementOperations })
    : input.originalText;
  if (input.approvedText !== expectedApprovedText) throw new AnalysisFailure('INVALID_OFFSETS');
  const fresh = analyze({ text: input.approvedText, policy: input.policy, customTerms: input.customTerms });
  const residual = fresh.detection.findings.filter(f => {
    const action = effectiveActionForFinding(f, input.policy);
    return action === 'REDACT' || action === 'BLOCK';
  });
  const requiresWarnAcknowledgement = fresh.decision.requiresWarnAcknowledgement || fresh.decision.action === 'WARN';
  const warningCanContinue = fresh.decision.action === 'WARN'
    ? fresh.decision.overrideAllowed && input.warnAcknowledged === true
    : !requiresWarnAcknowledgement || input.warnAcknowledged === true;
  return { safe: residual.length === 0 && warningCanContinue, requiresWarnAcknowledgement, residualFindings: residual };
}

export function redactAndVerify(input: AnalysisInput & { warnAcknowledged?: boolean }): { approvedText: string; analysis: AnalysisOutput; verification: VerifyRedactionOutput } {
  const analysis = analyze(input);
  const approvedText = analysis.decision.action === 'REDACT'
    ? applyRedaction({ text: input.text, operations: analysis.decision.replacementOperations })
    : input.text;
  const verification = verifyRedaction({ originalText: input.text, approvedText, analysis, policy: input.policy, customTerms: input.customTerms, warnAcknowledged: input.warnAcknowledged });
  if (!verification.safe) throw new AnalysisFailure('ENGINE_FAILURE');
  return { approvedText, analysis, verification };
}

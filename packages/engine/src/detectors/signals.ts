import { addFinding, type DetectorContext } from './shared.js';

export function detectContextSignals(context: DetectorContext): void {
  const marker = /\b(?:CONFIDENTIAL|INTERNAL ONLY|PROPRIETARY|DO NOT DISTRIBUTE)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(context.source))) addFinding(context, 'CONFIDENTIAL_MARKER', match.index, match.index + match[0].length, 'MEDIUM');
  const code = /\b(?:function\s+\w+|class\s+\w+|import\s+.+\s+from\s+['"]).{20,}/gs;
  while ((match = code.exec(context.source))) addFinding(context, 'SOURCE_CODE_CONTEXT', match.index, match.index + match[0].length, 'LOW');
}

export function detectCustomTerms(context: DetectorContext, customTerms: readonly string[]): void {
  for (const term of customTerms.slice(0, 250)) {
    if (term.length < 3 || term.length > 100) continue;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'giu');
    let match: RegExpExecArray | null;
    while ((match = regex.exec(context.source))) addFinding(context, 'CUSTOM_PROTECTED_TERM', match.index, match.index + match[0].length, 'HIGH');
  }
}

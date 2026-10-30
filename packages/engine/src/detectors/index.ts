import type { Finding } from '../types-internal.js';
import { AnalysisFailure } from '../types-internal.js';
import { normalizeWithMap } from '../normalize.js';
import { MAX_INPUT_UNITS } from '../chunk.js';
import { detectPii } from './pii.js';
import { detectSecrets } from './secrets.js';
import { detectContextSignals, detectCustomTerms } from './signals.js';
import { detectBulkContacts } from './bulk.js';
import { assertFindingBound, type DetectorContext } from './shared.js';

/** Runs local-only detectors and returns findings in original UTF-16 coordinates. */
export function scanText(text: string, customTerms: readonly string[] = []): Finding[] {
  if (text.length > MAX_INPUT_UNITS) throw new AnalysisFailure('INPUT_TOO_LONG');
  const context: DetectorContext = { source: '', map: normalizeWithMap(text), findings: [], seen: new Set() };
  context.source = context.map.normalized;
  detectPii(context);
  detectSecrets(context);
  detectContextSignals(context);
  detectCustomTerms(context, customTerms);
  detectBulkContacts(context);
  assertFindingBound(context.findings);
  return context.findings.sort((a, b) => a.start - b.start || a.end - b.end).map((finding, i) => ({ ...finding, id: `f${i + 1}` }));
}

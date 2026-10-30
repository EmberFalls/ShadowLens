import { AnalysisFailure } from './types-internal.js';

export interface NormalizedText { normalized: string; sourceStart: number[]; sourceEnd: number[] }
const ZERO_WIDTH = /[\u200B-\u200F\uFEFF]/g;

/** NFKC normalize one grapheme-ish code point at a time while preserving UTF-16 source ranges. */
export function normalizeWithMap(input: string): NormalizedText {
  let normalized = '';
  const sourceStart: number[] = [];
  const sourceEnd: number[] = [];
  for (let i = 0; i < input.length;) {
    const cp = input.codePointAt(i)!;
    const width = cp > 0xffff ? 2 : 1;
    const original = input.slice(i, i + width);
    const piece = original.normalize('NFKC').replace(ZERO_WIDTH, '');
    for (let j = 0; j < piece.length; j++) { normalized += piece[j]; sourceStart.push(i); sourceEnd.push(i + width); }
    i += width;
  }
  if (sourceStart.length !== normalized.length || sourceEnd.length !== normalized.length) throw new AnalysisFailure('NORMALIZATION_OVERFLOW');
  return { normalized, sourceStart, sourceEnd };
}

export function mapNormalizedSpan(map: NormalizedText, start: number, end: number): [number, number] {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > map.normalized.length) throw new AnalysisFailure('INVALID_OFFSETS');
  let originalStart = Number.POSITIVE_INFINITY;
  let originalEnd = 0;
  for (let i = start; i < end; i++) {
    originalStart = Math.min(originalStart, map.sourceStart[i]);
    originalEnd = Math.max(originalEnd, map.sourceEnd[i]);
  }
  if (!Number.isFinite(originalStart) || originalEnd <= originalStart) throw new AnalysisFailure('INVALID_OFFSETS');
  return [originalStart, originalEnd];
}

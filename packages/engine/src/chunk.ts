import { AnalysisFailure } from './types-internal.js';

export const MAX_INPUT_UNITS = 250_000;
export const CHUNK_UNITS = 8_192;
export const CHUNK_OVERLAP = 512;
export function* chunks(text: string): Generator<{ text: string; offset: number }> {
  if (text.length > MAX_INPUT_UNITS) throw new AnalysisFailure('INPUT_TOO_LONG');
  if (!text.length) return;
  const step = CHUNK_UNITS - CHUNK_OVERLAP;
  for (let offset = 0; offset < text.length; offset += step) yield { text: text.slice(offset, Math.min(text.length, offset + CHUNK_UNITS)), offset };
}

import type { Category, Severity } from '../types-internal.js';
import { chunks } from '../chunk.js';
import { addFinding, type DetectorContext } from './shared.js';

function luhn(value: string): boolean {
  let sum = 0, doubled = false;
  for (let i = value.length - 1; i >= 0; i--) { let digit = Number(value[i]); if (doubled) { digit *= 2; if (digit > 9) digit -= 9; } sum += digit; doubled = !doubled; }
  return sum % 10 === 0;
}

function verhoeff(value: string): boolean {
  const d = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
  const p = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
  let checksum = 0; const digits = [...value].reverse();
  for (let i = 0; i < digits.length; i++) checksum = d[checksum][p[i % 8][Number(digits[i])]];
  return checksum === 0;
}

type Pattern = [Category, RegExp, (candidate: string, index: number, source: string) => boolean, (candidate: string) => Severity | undefined];
const upiProviders = new Set(['okaxis','okhdfcbank','okicici','oksbi','ybl','ibl','axl','paytm','phonepe','gpay','apl','icici','axisbank','hdfcbank','sbi','upi']);
const patterns: Pattern[] = [
  ['PII_EMAIL', /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?){1,6}/gi, () => true, () => undefined],
  ['PII_PHONE', /(?<!\d)(?:(?:\+?91|0)[ -]?)?[6-9]\d{9}(?!\d)/g, () => true, () => undefined],
  ['PII_PAYMENT_CARD', /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g, c => { const n = c.replace(/\D/g, ''); return n.length >= 13 && n.length <= 19 && luhn(n); }, () => undefined],
  ['PII_AADHAAR', /(?<!\d)(?:\d[ -]?){11}\d(?!\d)/g, c => { const n = c.replace(/\D/g, ''); return n.length === 12 && verhoeff(n); }, () => undefined],
  ['PII_GSTIN', /(?<![A-Z0-9])(?:0[1-9]|[12]\d|3[0-8]|97)[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z](?![A-Z0-9])/gi, () => true, () => undefined],
  ['PII_IFSC', /(?<![A-Z0-9])[A-Z]{4}0[A-Z0-9]{6}(?![A-Z0-9])/gi, () => true, () => 'LOW'],
  ['PII_UPI', /(?<![\w.+-])[\w.-]{2,256}@[\w.-]{2,64}(?![\w.-])/g, (candidate, index, source) => {
    if (/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(candidate)) return false;
    const provider = candidate.slice(candidate.lastIndexOf('@') + 1).toLowerCase();
    const before = source.slice(Math.max(0, index - 40), index).split(/[;,\r\n]/).at(-1) ?? '';
    const after = source.slice(index + candidate.length, Math.min(source.length, index + candidate.length + 24)).split(/[;,\r\n]/)[0] ?? '';
    const context = `${before}${candidate}${after}`;
    return upiProviders.has(provider) || /\b(?:UPI|VPA|payment handle|pay to)\b/i.test(context);
  }, () => undefined],
];

export function detectPii(context: DetectorContext): void {
  for (const { text, offset } of chunks(context.source)) {
    for (const [category, regex, accept, severity] of patterns) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text))) {
        if (accept(match[0], offset + match.index, context.source)) addFinding(context, category, offset + match.index, offset + match.index + match[0].length, 'HIGH', severity(match[0]));
      }
    }
  }
  const ifscContext = /\b(?:IFSC|bank\s+code)\s*[:=-]?\s*([A-Z]{4}0[A-Z0-9]{6})\b/gi;
  let match: RegExpExecArray | null;
  while ((match = ifscContext.exec(context.source))) { const start = match.index + match[0].lastIndexOf(match[1]); addFinding(context, 'PII_IFSC', start, start + match[1].length, 'HIGH', 'MEDIUM'); }
  const pan = /(?<![A-Z0-9])[A-Z]{5}\d{4}[A-Z](?![A-Z0-9])/gi;
  while ((match = pan.exec(context.source))) { const explicit = /\bPAN\s*[:=-]?\s*$/i.test(context.source.slice(Math.max(0, match.index - 24), match.index)); addFinding(context, 'PII_INDIA_PAN', match.index, match.index + match[0].length, explicit ? 'HIGH' : 'MEDIUM', explicit ? 'HIGH' : 'MEDIUM'); }
}

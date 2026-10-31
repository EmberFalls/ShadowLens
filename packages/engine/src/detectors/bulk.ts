import { addFinding, type DetectorContext } from './shared.js';

export function detectBulkContacts(context: DetectorContext): void {
  const emails = context.findings.filter(f => f.category === 'PII_EMAIL').length;
  const phones = context.findings.filter(f => f.category === 'PII_PHONE').length;
  const header = /\b(?:name|email|phone)\s*,\s*(?:name|email|phone)\b/i.exec(context.source);
  const rowsAfterHeader = header
    ? context.source.slice(header.index).split(/\r?\n/u).filter(line => line.trim().length).length - 1
    : 0;
  // A header alone (or a tiny example table) is not enough to label a prompt
  // as a bulk disclosure. Require several data rows unless entity detection
  // independently found a large contact set.
  if (emails + phones >= 5 || (header !== null && rowsAfterHeader >= 5)) {
    const index = Math.max(0, context.source.search(/\b(?:name|email|phone)\s*,/i));
    addFinding(context, 'BULK_CONTACT_LIST', index, Math.min(context.source.length, index + 1), 'HIGH');
  }
}

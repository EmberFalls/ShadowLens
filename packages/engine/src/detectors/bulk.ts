import { addFinding, type DetectorContext } from './shared.js';

export function detectBulkContacts(context: DetectorContext): void {
  const emails = context.findings.filter(f => f.category === 'PII_EMAIL').length;
  const phones = context.findings.filter(f => f.category === 'PII_PHONE').length;
  const csv = /\b(?:name|email|phone)\s*,\s*(?:name|email|phone)\b/i.test(context.source);
  if (emails + phones >= 5 || csv) {
    const index = Math.max(0, context.source.search(/\b(?:name|email|phone)\s*,/i));
    addFinding(context, 'BULK_CONTACT_LIST', index, Math.min(context.source.length, index + 1), 'HIGH');
  }
}

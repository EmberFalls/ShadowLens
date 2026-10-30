/* Generated from schemas/analysis.schema.json; do not edit. */

/**
 * This interface was referenced by `LocalAnalysisOutputV2`'s JSON-Schema
 * via the `definition` "category".
 */
export type Category =
  | 'PII_EMAIL'
  | 'PII_PHONE'
  | 'PII_PAYMENT_CARD'
  | 'PII_AADHAAR'
  | 'PII_INDIA_PAN'
  | 'PII_GSTIN'
  | 'PII_IFSC'
  | 'PII_UPI'
  | 'SECRET_TOKEN'
  | 'SECRET_PRIVATE_KEY'
  | 'CONFIDENTIAL_MARKER'
  | 'SOURCE_CODE_CONTEXT'
  | 'CUSTOM_PROTECTED_TERM'
  | 'BULK_CONTACT_LIST';
/**
 * This interface was referenced by `LocalAnalysisOutputV2`'s JSON-Schema
 * via the `definition` "severity".
 */
export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface LocalAnalysisOutputV2 {
  contractVersion: 'v2';
  engineVersion: string;
  inputLength: number;
  /**
   * @maxItems 10000
   */
  findings: Finding[];
  categoryCounts: {
    [k: string]: number;
  };
  highestFindingSeverity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | null;
  aggregateScore: number;
  aggregateTier: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  scanCompleteness: 'FULL';
}
/**
 * This interface was referenced by `LocalAnalysisOutputV2`'s JSON-Schema
 * via the `definition` "finding".
 */
export interface Finding {
  id: string;
  ruleId:
    | 'PII.EMAIL'
    | 'PII.INDIA_MOBILE'
    | 'PII.PAYMENT_CARD'
    | 'PII.AADHAAR'
    | 'PII.INDIA_PAN'
    | 'PII.GSTIN'
    | 'PII.IFSC'
    | 'PII.UPI'
    | 'SECRET.TOKEN'
    | 'SECRET.PEM_PRIVATE_KEY'
    | 'CONFIDENTIAL.MARKER'
    | 'CODE.STRUCTURE'
    | 'CONFIDENTIAL.CUSTOM_TERM'
    | 'PII.BULK_CONTACT_LIST';
  category: Category;
  severity: Severity;
  start: number;
  end: number;
  confidenceHint: 'LOW' | 'MEDIUM' | 'HIGH';
  replaceable: boolean;
  explanationCode:
    | 'EXPLAIN_CONTACT_EMAIL'
    | 'EXPLAIN_CONTACT_PHONE'
    | 'EXPLAIN_PAYMENT_CARD'
    | 'EXPLAIN_AADHAAR'
    | 'EXPLAIN_INDIA_PAN'
    | 'EXPLAIN_GSTIN'
    | 'EXPLAIN_IFSC'
    | 'EXPLAIN_UPI'
    | 'EXPLAIN_PROVIDER_TOKEN'
    | 'EXPLAIN_PRIVATE_KEY'
    | 'EXPLAIN_CONFIDENTIAL_MARKER'
    | 'EXPLAIN_SOURCE_CODE'
    | 'EXPLAIN_BULK_CONTACT_LIST'
    | 'EXPLAIN_CUSTOM_PROTECTED_TERM';
}

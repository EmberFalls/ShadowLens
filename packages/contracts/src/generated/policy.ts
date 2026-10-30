/* Generated from schemas/policy.schema.json; do not edit. */

export type PolicyConfigAndDecisionV2 = Config | Decision;
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
export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type Action = 'ALLOW' | 'WARN' | 'REDACT' | 'BLOCK';
export type ReasonCode =
  | 'DETECTED_PII'
  | 'DETECTED_SECRET'
  | 'DETECTED_CONFIDENTIAL'
  | 'DETECTED_SOURCE_CODE'
  | 'DETECTED_BULK'
  | 'DETECTED_CUSTOM_TERM'
  | 'POLICY_ALLOW'
  | 'POLICY_WARN'
  | 'POLICY_REDACT'
  | 'POLICY_BLOCK'
  | 'POLICY_FALLBACK_WARN'
  | 'REDACTION_RESIDUAL';

export interface Config {
  contractVersion: 'v2';
  revision: number;
  defaultFindingAction: 'WARN' | 'BLOCK';
  /**
   * @maxItems 32
   */
  rules: {
    id: string;
    category: Category | '*';
    minimumSeverity: Severity;
    action: Action;
    enabled: boolean;
  }[];
  allowWarnOverride: boolean;
  updatedAt: string;
}
export interface Decision {
  action: Action;
  score: number;
  aggregateTier: 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  matchedRuleIds: string[];
  /**
   * @maxItems 8
   */
  reasonCodes:
    | []
    | [ReasonCode]
    | [ReasonCode, ReasonCode]
    | [ReasonCode, ReasonCode, ReasonCode]
    | [ReasonCode, ReasonCode, ReasonCode, ReasonCode]
    | [ReasonCode, ReasonCode, ReasonCode, ReasonCode, ReasonCode]
    | [ReasonCode, ReasonCode, ReasonCode, ReasonCode, ReasonCode, ReasonCode]
    | [ReasonCode, ReasonCode, ReasonCode, ReasonCode, ReasonCode, ReasonCode, ReasonCode]
    | [ReasonCode, ReasonCode, ReasonCode, ReasonCode, ReasonCode, ReasonCode, ReasonCode, ReasonCode];
  overrideAllowed: boolean;
  requiresWarnAcknowledgement: boolean;
  replacementOperations: {
    start: number;
    end: number;
    replacement: string;
    category: Category;
  }[];
  policyRevision: number;
}

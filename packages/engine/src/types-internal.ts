export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type RiskTier = 'NONE' | Severity;
export type DecisionAction = 'ALLOW' | 'WARN' | 'REDACT' | 'BLOCK';
export type Category = 'PII_EMAIL' | 'PII_PHONE' | 'PII_PAYMENT_CARD' | 'PII_AADHAAR' | 'PII_INDIA_PAN' | 'PII_GSTIN' | 'PII_IFSC' | 'PII_UPI' | 'SECRET_TOKEN' | 'SECRET_PRIVATE_KEY' | 'CONFIDENTIAL_MARKER' | 'SOURCE_CODE_CONTEXT' | 'CUSTOM_PROTECTED_TERM' | 'BULK_CONTACT_LIST';
export type ExplanationCode = 'EXPLAIN_CONTACT_EMAIL' | 'EXPLAIN_CONTACT_PHONE' | 'EXPLAIN_PAYMENT_CARD' | 'EXPLAIN_AADHAAR' | 'EXPLAIN_INDIA_PAN' | 'EXPLAIN_GSTIN' | 'EXPLAIN_IFSC' | 'EXPLAIN_UPI' | 'EXPLAIN_PROVIDER_TOKEN' | 'EXPLAIN_PRIVATE_KEY' | 'EXPLAIN_CONFIDENTIAL_MARKER' | 'EXPLAIN_SOURCE_CODE' | 'EXPLAIN_BULK_CONTACT_LIST' | 'EXPLAIN_CUSTOM_PROTECTED_TERM';
export type ReasonCode = 'DETECTED_PII' | 'DETECTED_SECRET' | 'DETECTED_CONFIDENTIAL' | 'DETECTED_SOURCE_CODE' | 'DETECTED_BULK' | 'DETECTED_CUSTOM_TERM' | 'POLICY_ALLOW' | 'POLICY_WARN' | 'POLICY_REDACT' | 'POLICY_BLOCK' | 'POLICY_FALLBACK_WARN' | 'REDACTION_RESIDUAL';
export type RuleId = 'PII.EMAIL' | 'PII.INDIA_MOBILE' | 'PII.PAYMENT_CARD' | 'PII.AADHAAR' | 'PII.INDIA_PAN' | 'PII.GSTIN' | 'PII.IFSC' | 'PII.UPI' | 'SECRET.TOKEN' | 'SECRET.PEM_PRIVATE_KEY' | 'CONFIDENTIAL.MARKER' | 'CODE.STRUCTURE' | 'CONFIDENTIAL.CUSTOM_TERM' | 'PII.BULK_CONTACT_LIST';
export interface Finding { id: string; ruleId: RuleId; category: Category; severity: Severity; start: number; end: number; confidenceHint: 'LOW' | 'MEDIUM' | 'HIGH'; replaceable: boolean; explanationCode: ExplanationCode }
export interface DetectionResult { contractVersion: 'v2'; engineVersion: string; inputLength: number; findings: Finding[]; categoryCounts: Partial<Record<Category, number>>; highestFindingSeverity: Severity | null; aggregateScore: number; aggregateTier: RiskTier; scanCompleteness: 'FULL' }
export interface ReplacementOperation { start: number; end: number; replacement: string; category: Category }
export interface PolicyRule { id: string; category: Category | '*'; minimumSeverity: Severity; action: DecisionAction; enabled: boolean }
export interface PolicyConfig { contractVersion: 'v2'; revision: number; defaultFindingAction: 'WARN' | 'BLOCK'; rules: PolicyRule[]; allowWarnOverride: boolean; updatedAt: string }
export interface PolicyDecision { action: DecisionAction; score: number; aggregateTier: RiskTier; matchedRuleIds: string[]; reasonCodes: ReasonCode[]; overrideAllowed: boolean; requiresWarnAcknowledgement: boolean; replacementOperations: ReplacementOperation[]; policyRevision: number }
export interface AnalysisInput { text: string; policy: PolicyConfig; customTerms?: readonly string[] }
export interface AnalysisOutput { detection: DetectionResult; decision: PolicyDecision }
export type AnalysisFailureCode = 'INPUT_TOO_LONG' | 'SCANNER_TIMEOUT' | 'ENGINE_FAILURE' | 'INVALID_POLICY' | 'INVALID_OFFSETS' | 'NORMALIZATION_OVERFLOW';
export class AnalysisFailure extends Error { constructor(public readonly code: AnalysisFailureCode) { super(code); this.name = 'AnalysisFailure'; } }
export interface ScoreResult { score: number; tier: RiskTier; highestSeverity: Severity | null; categoryCounts: Partial<Record<Category, number>>; reasonCodes: ReasonCode[] }
export interface TextStats { uniqueContactCount?: number; contactCsv?: boolean }
export interface DetectionForPolicy { findings: readonly Finding[]; score: number; tier: RiskTier; }
export interface VerifyRedactionInput { originalText: string; approvedText: string; analysis: AnalysisOutput; policy: PolicyConfig; customTerms?: readonly string[]; warnAcknowledged?: boolean }
export interface VerifyRedactionOutput { safe: boolean; requiresWarnAcknowledgement: boolean; residualFindings: Finding[] }

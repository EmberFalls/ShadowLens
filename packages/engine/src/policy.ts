import { AnalysisFailure, type DecisionAction, type DetectionForPolicy, type PolicyConfig, type PolicyDecision, type ReasonCode, type Severity } from './types-internal.js';

const severityRank: Record<Severity, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
const actionRank: Record<DecisionAction, number> = { ALLOW: 0, WARN: 1, REDACT: 2, BLOCK: 3 };
const actionReason = { ALLOW: 'POLICY_ALLOW', WARN: 'POLICY_WARN', REDACT: 'POLICY_REDACT', BLOCK: 'POLICY_BLOCK' } as const;
const hardRules = new Set(['SECRET_PRIVATE_KEY']);
const categories = new Set(['PII_EMAIL','PII_PHONE','PII_PAYMENT_CARD','PII_AADHAAR','PII_INDIA_PAN','PII_GSTIN','PII_IFSC','PII_UPI','SECRET_TOKEN','SECRET_PRIVATE_KEY','CONFIDENTIAL_MARKER','SOURCE_CODE_CONTEXT','CUSTOM_PROTECTED_TERM','BULK_CONTACT_LIST']);

export function effectiveActionForFinding(finding: DetectionForPolicy['findings'][number], policy: PolicyConfig): DecisionAction {
  const rules = policy.rules.filter(rule => rule.enabled && (rule.category === finding.category || rule.category === '*') && severityRank[finding.severity] >= severityRank[rule.minimumSeverity]);
  if (!rules.length) return policy.defaultFindingAction;
  return rules.reduce<DecisionAction>((strongest, rule) => {
    const action = rule.action === 'REDACT' && !finding.replaceable ? 'BLOCK' : rule.action;
    return actionRank[action] > actionRank[strongest] ? action : strongest;
  }, 'ALLOW');
}

export function validatePolicy(policy: PolicyConfig): void {
  const configKeys = ['contractVersion', 'revision', 'defaultFindingAction', 'rules', 'allowWarnOverride', 'updatedAt'];
  if (!policy || typeof policy !== 'object' || Object.keys(policy).some(key => !configKeys.includes(key)) || policy.contractVersion !== 'v2' || !Number.isInteger(policy.revision) || policy.revision < 1 || !['WARN', 'BLOCK'].includes(policy.defaultFindingAction) || !Array.isArray(policy.rules) || policy.rules.length > 32 || typeof policy.updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(policy.updatedAt) || !Number.isFinite(Date.parse(policy.updatedAt)) || typeof policy.allowWarnOverride !== 'boolean') throw new AnalysisFailure('INVALID_POLICY');
  const ids = new Set<string>();
  for (const rule of policy.rules) {
    const ruleKeys = ['id', 'category', 'minimumSeverity', 'action', 'enabled'];
    if (!rule || typeof rule !== 'object' || Object.keys(rule).some(key => !ruleKeys.includes(key)) || typeof rule.id !== 'string' || !rule.id.trim() || ids.has(rule.id) || (rule.category !== '*' && !categories.has(rule.category)) || !['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(rule.minimumSeverity) || !['ALLOW', 'WARN', 'REDACT', 'BLOCK'].includes(rule.action) || typeof rule.enabled !== 'boolean') throw new AnalysisFailure('INVALID_POLICY');
    ids.add(rule.id);
    if (hardRules.has(rule.category) && (!rule.enabled || rule.action !== 'BLOCK' || rule.minimumSeverity !== 'LOW')) throw new AnalysisFailure('INVALID_POLICY');
  }
  for (const category of hardRules) {
    if (!policy.rules.some(rule => rule.category === category && rule.enabled && rule.action === 'BLOCK')) throw new AnalysisFailure('INVALID_POLICY');
  }
}

export function evaluatePolicy(input: { detection: DetectionForPolicy; policy: PolicyConfig }): PolicyDecision {
  validatePolicy(input.policy);
  const { findings } = input.detection;
  const matched = new Map<string, DecisionAction>();
  const effectiveActions: DecisionAction[] = [];
  let hasFallbackFinding = false;
  for (const finding of findings) {
    const rules = input.policy.rules.filter(r => r.enabled && (r.category === finding.category || r.category === '*') && severityRank[finding.severity] >= severityRank[r.minimumSeverity]);
    if (!rules.length) {
      hasFallbackFinding = true;
      effectiveActions.push(input.policy.defaultFindingAction);
      continue;
    }
    let strongest: DecisionAction = 'ALLOW';
    for (const rule of rules) {
      const action = rule.action === 'REDACT' && !finding.replaceable ? 'BLOCK' : rule.action;
      matched.set(rule.id, action);
      if (actionRank[action] > actionRank[strongest]) strongest = action;
    }
    effectiveActions.push(strongest);
  }
  let action: DecisionAction;
  const fallback = hasFallbackFinding;
  action = effectiveActions.sort((a, b) => actionRank[b] - actionRank[a])[0] ?? 'ALLOW';
  const reasonCodes = new Set<ReasonCode>(findings.map(f => f.category.startsWith('PII_') ? 'DETECTED_PII' : f.category.startsWith('SECRET_') ? 'DETECTED_SECRET' : f.category === 'CONFIDENTIAL_MARKER' ? 'DETECTED_CONFIDENTIAL' : f.category === 'SOURCE_CODE_CONTEXT' ? 'DETECTED_SOURCE_CODE' : f.category === 'BULK_CONTACT_LIST' ? 'DETECTED_BULK' : 'DETECTED_CUSTOM_TERM'));
  if (fallback && input.policy.defaultFindingAction === 'WARN') reasonCodes.add('POLICY_FALLBACK_WARN');
  reasonCodes.add(actionReason[action]);
  const requiresWarnAcknowledgement = action === 'WARN' || (action === 'REDACT' && effectiveActions.some(a => a === 'WARN'));
  return { action, score: input.detection.score, aggregateTier: input.detection.tier, matchedRuleIds: [...matched.keys()].sort(), reasonCodes: [...reasonCodes], overrideAllowed: action === 'WARN' && input.policy.allowWarnOverride, requiresWarnAcknowledgement, replacementOperations: [], policyRevision: input.policy.revision };
}

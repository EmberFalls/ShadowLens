import type { PolicyConfig } from './types-internal.js';
export const DEFAULT_POLICY: PolicyConfig = {
  contractVersion:'v2', revision:1, defaultFindingAction:'WARN', allowWarnOverride:true, updatedAt:'2026-10-30T00:00:00Z',
  rules:[
    {id:'POLICY.PRIVATE_KEY',category:'SECRET_PRIVATE_KEY',minimumSeverity:'LOW',action:'BLOCK',enabled:true},
    {id:'POLICY.TOKEN',category:'SECRET_TOKEN',minimumSeverity:'HIGH',action:'REDACT',enabled:true},
    {id:'POLICY.CARD',category:'PII_PAYMENT_CARD',minimumSeverity:'HIGH',action:'REDACT',enabled:true},
    {id:'POLICY.AADHAAR',category:'PII_AADHAAR',minimumSeverity:'HIGH',action:'REDACT',enabled:true},
    {id:'POLICY.INDIA_PAN',category:'PII_INDIA_PAN',minimumSeverity:'HIGH',action:'REDACT',enabled:true},
    {id:'POLICY.EMAIL',category:'PII_EMAIL',minimumSeverity:'MEDIUM',action:'REDACT',enabled:true},
    {id:'POLICY.PHONE',category:'PII_PHONE',minimumSeverity:'MEDIUM',action:'REDACT',enabled:true},
    {id:'POLICY.MARKER',category:'CONFIDENTIAL_MARKER',minimumSeverity:'HIGH',action:'WARN',enabled:true},
    {id:'POLICY.CODE',category:'SOURCE_CODE_CONTEXT',minimumSeverity:'MEDIUM',action:'WARN',enabled:true},
    {id:'POLICY.BULK',category:'BULK_CONTACT_LIST',minimumSeverity:'HIGH',action:'WARN',enabled:true},
  ]
};

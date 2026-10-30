import { addFinding, type DetectorContext } from './shared.js';

export function detectSecrets(context: DetectorContext): void {
  const providerTokens = /(?<![A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{20,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})(?![A-Za-z0-9])/g;
  let token: RegExpExecArray | null;
  while ((token = providerTokens.exec(context.source))) if (!['NOT_A_REAL_KEY', 'FAKEKEY'].includes(token[0])) addFinding(context, 'SECRET_TOKEN', token.index, token.index + token[0].length, 'HIGH');
  const privateKey = /-----BEGIN (?:(?:RSA|EC|OPENSSH|DSA|ENCRYPTED) )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:(?:RSA|EC|OPENSSH|DSA|ENCRYPTED) )?PRIVATE KEY-----|$)/g;
  let match: RegExpExecArray | null;
  while ((match = privateKey.exec(context.source))) addFinding(context, 'SECRET_PRIVATE_KEY', match.index, match.index + match[0].length, 'HIGH');
  const assignment = /\b(?:[A-Z0-9_]*(?:PASSWORD|PASSWD|API[_-]?KEY|SECRET|TOKEN)|password|passwd|api[_-]?key|secret|token)\s*[:=]\s*['"]?([^\s'";,]{1,})/gi;
  while ((match = assignment.exec(context.source))) {
    if (['NOT_A_REAL_KEY', 'FAKEKEY'].includes(match[1])) continue;
    const start = match.index + match[0].lastIndexOf(match[1]);
    addFinding(context, 'SECRET_TOKEN', start, start + match[1].length, 'MEDIUM');
  }
  const connectionString = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^:\s/@]+:[^@\s/]+@[^\s'";,]+/gi;
  while ((match = connectionString.exec(context.source))) addFinding(context, 'SECRET_TOKEN', match.index, match.index + match[0].length, 'HIGH');
}

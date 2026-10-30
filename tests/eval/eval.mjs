import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const HOLDOUT = process.argv.includes('--holdout');
const SEED = 17017;
const CATEGORIES = new Set(['PII_EMAIL','PII_PHONE','PII_PAYMENT_CARD','PII_AADHAAR','PII_INDIA_PAN','PII_GSTIN','PII_IFSC','PII_UPI','SECRET_TOKEN','SECRET_PRIVATE_KEY','CONFIDENTIAL_MARKER','SOURCE_CODE_CONTEXT','CUSTOM_PROTECTED_TERM','BULK_CONTACT_LIST']);
const ACTIONS = new Set(['ALLOW','WARN','REDACT','BLOCK']);
const TRUTHS = new Set(['SENSITIVE','BENIGN','AMBIGUOUS']);
const COMPOSITIONS = new Set(['SINGLE','MIXED']);
const REQUIRED = ['id','split','source','text','truth','composition','supportedScope','expectedEntities','expectedAction','tags','templateFamily','notes'];

function fail(message) { throw new Error(`Corpus validation failed: ${message}`); }
export function validateRecord(row, ids = new Set()) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) fail('record must be an object');
  const keys = Object.keys(row).sort();
  if (keys.join('|') !== [...REQUIRED].sort().join('|')) fail('record keys do not match the frozen record schema');
  if (typeof row.id !== 'string' || !/^(hand|generated|holdout)_\d{4}$/.test(row.id) || ids.has(row.id)) fail('invalid or duplicate id');
  ids.add(row.id);
  if (!['train_dev','holdout','generated'].includes(row.split) || !TRUTHS.has(row.truth) || !COMPOSITIONS.has(row.composition) || !ACTIONS.has(row.expectedAction)) fail('invalid split/truth/composition/action enum');
  if (typeof row.source !== 'string' || !row.source || typeof row.text !== 'string' || !row.text.length || row.text.length > 250000) fail('invalid source or text');
  if (row.supportedScope !== 'SANDBOX_TEXT' || !Array.isArray(row.expectedEntities) || !Array.isArray(row.tags) || !row.tags.every(x => typeof x === 'string') || typeof row.templateFamily !== 'string' || typeof row.notes !== 'string') fail('invalid scope/annotations/tags/family/notes');
  let lastEnd = -1;
  for (const entity of row.expectedEntities) {
    if (!entity || Object.keys(entity).sort().join('|') !== 'category|end|start|value' || !CATEGORIES.has(entity.category) || !Number.isInteger(entity.start) || !Number.isInteger(entity.end) || entity.start < 0 || entity.end <= entity.start || entity.end > row.text.length || typeof entity.value !== 'string' || !entity.value) fail('invalid entity annotation');
    if (row.text.slice(entity.start, entity.end) !== entity.value) fail('annotation value does not match raw fixture text');
    if (entity.start < lastEnd) fail('overlapping or unsorted entity annotations');
    lastEnd = entity.end;
  }
  if (row.truth === 'SENSITIVE' && row.expectedEntities.length === 0) fail('sensitive row requires a labeled entity');
  if (row.truth === 'BENIGN' && row.expectedEntities.length !== 0) fail('benign row cannot have sensitive entity labels');
  if (row.composition === 'MIXED' && row.truth !== 'SENSITIVE') fail('MIXED is a composition tag on a sensitive record');
  if (row.split === 'generated' && row.source !== 'template_generator') fail('generated source mismatch');
  if (row.split === 'holdout' && row.source !== 'independent_human' && row.source !== 'candidate_pending_review') fail('holdout provenance mismatch');
  return row;
}

export function parseJsonl(raw, label) {
  const ids = new Set();
  const rows = raw.split(/\r?\n/).filter(Boolean).map((line, index) => {
    let row; try { row = JSON.parse(line); } catch { fail(`${label} line ${index + 1} is not JSON`); }
    try { return validateRecord(row, ids); } catch (error) { fail(`${label} line ${index + 1}: ${error.message}`); }
  });
  return rows;
}

function spanMatch(expected, predicted) {
  const compatible = predicted.filter(found => found.category === expected.category && Math.max(0, Math.min(found.end, expected.end) - Math.max(found.start, expected.start)) / (expected.end - expected.start) >= 0.9);
  return compatible;
}
export function maximumEntityMatches(expectedEntities, predicted) {
  const assigned = new Map();
  function assign(expectedIndex, visited) {
    for (let p = 0; p < predicted.length; p++) {
      if (visited.has(p) || spanMatch(expectedEntities[expectedIndex], [predicted[p]]).length === 0) continue;
      visited.add(p);
      if (!assigned.has(p) || assign(assigned.get(p), visited)) { assigned.set(p, expectedIndex); return true; }
    }
    return false;
  }
  let matches = 0;
  for (let e = 0; e < expectedEntities.length; e++) if (assign(e, new Set())) matches++;
  return matches;
}
function rate(n, d) { return { value: d === 0 ? null : n / d, numerator: n, denominator: d, display: d === 0 ? `N/A (0/${d})` : `${(100 * n / d).toFixed(2)}% (${n}/${d})` }; }
export function wilsonUpper(successes, n, z = 1.959963984540054) {
  if (!n) return null;
  const p = successes / n, z2 = z * z;
  return (p + z2 / (2 * n) + z * Math.sqrt((p * (1 - p) / n) + z2 / (4 * n * n))) / (1 + z2 / n);
}
export function emptyCounts() { return { tp: 0, fp: 0, tn: 0, fn: 0, predictedPositive: 0, actualPositive: 0, benign: 0, benignBlocks: 0, benignPrevented: 0, ambiguous: 0, ambiguousDetected: 0, ambiguousEscalated: 0, entityExpected: 0, entityMatched: 0, entityPredicted: 0, policyEligible: 0, policyCorrect: 0, redactionEntitiesRequired: 0, redactionResidualEntities: 0, unsafeRedactionReleases: 0, engineFailures: 0 };
}
export function buildMetrics(c = emptyCounts()) {
  const precision = rate(c.tp, c.tp + c.fp), recall = rate(c.tp, c.tp + c.fn);
  const f1den = 2 * c.tp + c.fp + c.fn;
  return {
    prompt: { tp: c.tp, fp: c.fp, tn: c.tn, fn: c.fn, precision, recall, f1: f1den ? { value: 2 * c.tp / f1den, numerator: 2 * c.tp, denominator: f1den, display: `${(200 * c.tp / f1den).toFixed(2)}%` } : { value: null, numerator: 0, denominator: 0, display: 'N/A (0/0)' }, falsePositiveRate: rate(c.fp, c.fp + c.tn) },
    benign: { evaluated: c.benign, falseBlockRate: rate(c.benignBlocks, c.benign), benignPreventedRate: rate(c.benignPrevented, c.benign), falseBlockWilson95Upper: wilsonUpper(c.benignBlocks, c.benign) },
    ambiguous: { excludedFromBinaryMetrics: c.ambiguous, detected: c.ambiguousDetected, escalated: c.ambiguousEscalated },
    entities: { expected: c.entityExpected, matched: c.entityMatched, predicted: c.entityPredicted, precision: rate(c.entityMatched, c.entityPredicted), recall: rate(c.entityMatched, c.entityExpected) },
    perCategory: Object.fromEntries(Object.entries(c.perCategory ?? {}).sort(([a],[b])=>a.localeCompare(b)).map(([category,value])=>[category,{expected:value.expected,matched:value.matched,predicted:value.predicted,recall:rate(value.matched,value.expected),precision:rate(value.matched,value.predicted)}])),
    policy: { eligible: c.policyEligible, exactActionMatches: c.policyCorrect, correctness: rate(c.policyCorrect, c.policyEligible) },
    redaction: { entitiesRequired: c.redactionEntitiesRequired, residualEntities: c.redactionResidualEntities, residualRate: rate(c.redactionResidualEntities, c.redactionEntitiesRequired), unsafeRedactionReleases: c.unsafeRedactionReleases },
    engineFailures: c.engineFailures,
  };
}
export const DUPLICATE_FAMILY_CAVEAT = 'Template-family samples are correlated; Wilson bounds use row counts and must not be interpreted as independent evidence. No row-level bootstrap is reported; a family-cluster bootstrap would be required for family-level uncertainty.';
export function addCase(c, row, outcome) {
  const findings = outcome?.analysis?.detection?.findings ?? [];
  const detected = findings.some(f => CATEGORIES.has(f.category));
  const action = outcome?.analysis?.decision?.action ?? 'FAILED_SAFE';
  const blocked = action === 'BLOCK';
  const prevented = blocked || action === 'FAILED_SAFE';
  if (row.truth === 'AMBIGUOUS') {
    c.ambiguous++; c.ambiguousDetected += Number(detected); c.ambiguousEscalated += Number(['WARN','REDACT','BLOCK','FAILED_SAFE'].includes(action));
  } else {
    if (row.truth === 'BENIGN') { c.benign++; c.benignBlocks += Number(blocked); c.benignPrevented += Number(prevented); }
    if (detected) c.predictedPositive++;
    if (row.truth === 'SENSITIVE') c.actualPositive++;
    if (row.truth === 'SENSITIVE' && detected) c.tp++;
    else if (row.truth === 'SENSITIVE') c.fn++;
    else if (detected) c.fp++;
    else c.tn++;
    c.policyEligible++;
    c.policyCorrect += Number(action === row.expectedAction);
    c.entityExpected += row.expectedEntities.length;
    c.entityPredicted += findings.length;
    c.entityMatched += maximumEntityMatches(row.expectedEntities, findings);
    c.perCategory ??= {};
    for (const category of CATEGORIES) {
      const expected = row.expectedEntities.filter(entity=>entity.category===category);
      const predicted = findings.filter(finding=>finding.category===category);
      if (!expected.length && !predicted.length) continue;
      const stats=c.perCategory[category] ??= {expected:0,matched:0,predicted:0};
      stats.expected += expected.length;
      stats.predicted += predicted.length;
      stats.matched += maximumEntityMatches(expected,predicted);
    }
    if (row.expectedAction === 'REDACT') {
      c.redactionEntitiesRequired += row.expectedEntities.length;
      const operations = outcome?.analysis?.decision?.replacementOperations ?? [];
      let approved = row.text;
      for (const op of [...operations].sort((a,b) => b.start - a.start)) approved = approved.slice(0,op.start) + op.replacement + approved.slice(op.end);
      let residuals = 0;
      for (const entity of row.expectedEntities) {
        const wasReplaced = operations.some(op => op.start <= entity.start && op.end >= entity.end);
        if (!wasReplaced) residuals++;
      }
      c.redactionResidualEntities += residuals;
      c.unsafeRedactionReleases += Number(action === 'REDACT' && residuals > 0);
    }
  }
  if (action === 'FAILED_SAFE') c.engineFailures++;
}

async function lines(name) { return readFile(resolve(here, name), 'utf8'); }
async function main() {
  const started = performance.now();
  const hand = parseJsonl(await lines('hand-authored.jsonl'), 'hand-authored');
  const generated = parseJsonl(await lines('generated.jsonl'), 'generated');
  const holdoutCandidates = parseJsonl(await lines('holdout-candidates.jsonl'), 'holdout candidates');
  const sourceSha = process.env.ENGINE_SHA || execFileSync('git', ['rev-parse','HEAD'], { cwd: resolve(here,'../..'), encoding:'utf8' }).trim();
  if (hand.filter(x => x.split === 'train_dev').length < 120) fail('expected at least 120 hand-authored development cases');
  if (generated.length < 1000 || generated.filter(x => x.truth === 'BENIGN').length < 150) fail('generated minimum not met');
  if (holdoutCandidates.length < 30) fail('expected at least 30 holdout candidates');
  let holdout = [];
  if (HOLDOUT) {
    let holdoutRaw, attestationRaw;
    try { holdoutRaw=await lines('holdout.jsonl'); attestationRaw=await lines('holdout-attestation.json'); }
    catch { fail('independent frozen holdout or reviewer attestation is missing; no holdout result was produced'); }
    holdout = parseJsonl(holdoutRaw, 'holdout');
    let attestation; try { attestation=JSON.parse(attestationRaw); } catch { fail('holdout attestation is not valid JSON'); }
    const holdoutHash = createHash('sha256').update(holdoutRaw).digest('hex');
    if (!process.env.DETECTOR_AUTHOR_ID || !process.env.EVALUATOR_ID || process.env.DETECTOR_AUTHOR_ID === process.env.EVALUATOR_ID) fail('set distinct DETECTOR_AUTHOR_ID and EVALUATOR_ID before holdout scoring');
    const reviewerIsAuthor = attestation.reviewerId === process.env.DETECTOR_AUTHOR_ID;
    const reviewerIsOperator = attestation.reviewerId === process.env.EVALUATOR_ID;
    const releaseSha = process.env.RELEASE_ENGINE_SHA;
    const attestationKeys = Object.keys(attestation).sort().join('|');
    if (attestationKeys !== 'reviewedAt|reviewerId|sha256' || holdout.length < 30 || holdout.some(row => row.split !== 'holdout' || row.source !== 'independent_human') || !attestation.reviewerId || attestation.reviewerId === 'PENDING' || reviewerIsAuthor || reviewerIsOperator || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(attestation.reviewedAt ?? '') || !Number.isFinite(Date.parse(attestation.reviewedAt)) || attestation.sha256 !== holdoutHash || !/^[0-9a-f]{40}$/i.test(releaseSha ?? '') || sourceSha !== releaseSha) fail('holdout must have 30+ independently authored rows, matching human attestation, distinct reviewer identity, and frozen release engine SHA');
  }
  const datasetHash = createHash('sha256').update([await lines('hand-authored.jsonl'), await lines('generated.jsonl'), ...(HOLDOUT ? [await lines('holdout.jsonl')] : [])].join('\n--dataset--\n')).digest('hex');
  const engineDir = process.env.EVAL_ENGINE_DIR ? resolve(here, process.env.EVAL_ENGINE_DIR) : resolve(here, '../../packages/engine/dist');
  let engine;
  try { engine = await import(pathToFileURL(join(engineDir,'index.js')).href); } catch { fail('built engine missing; run npm run build:engine from repository root or set EVAL_ENGINE_DIR to an equivalent frozen build'); }
  const { analyze } = engine;
  const { DEFAULT_POLICY } = await import(pathToFileURL(join(engineDir,'default-policy.js')).href);
  const runGroup = (rows) => {
    const total = emptyCounts(), families = new Map();
    for (const row of rows) {
      let outcome;
      try { outcome = { analysis: analyze({ text: row.text, policy: DEFAULT_POLICY }) }; }
      catch (error) { outcome = { analysis: null }; }
      addCase(total, row, outcome);
      const family = row.templateFamily || 'unspecified';
      if (!families.has(family)) families.set(family, emptyCounts());
      addCase(families.get(family), row, outcome);
    }
    return { n: rows.length, truthCounts: Object.fromEntries(['SENSITIVE','BENIGN','AMBIGUOUS'].map(truth => [truth, rows.filter(row => row.truth === truth).length])), metrics: buildMetrics(total), templateFamilies: Object.fromEntries([...families].sort(([a],[b]) => a.localeCompare(b)).map(([key,value]) => [key,{n:rows.filter(row=>row.templateFamily===key).length,metrics:buildMetrics(value)}])) };
  };
  const scoredHand = hand.filter(row => row.split === 'train_dev');
  const scoredGenerated = generated;
  const scoredHoldout = HOLDOUT ? runGroup(holdout) : null;
  const engineVersion = analyze({text:'',policy:DEFAULT_POLICY}).detection.engineVersion;
  const record = { reportVersion: 'v1', evaluationStage: HOLDOUT ? 'sealed-holdout' : 'development-current-branch', releaseReady: HOLDOUT, datasetHash, engineBuildSha: sourceSha, engineVersion, policyRevision: DEFAULT_POLICY.revision, randomSeed: SEED, generatedFamilyCaveat: DUPLICATE_FAMILY_CAVEAT, uncertaintyCaveat: 'Synthetic results are not production accuracy. Wilson bounds describe only this sampled distribution under independence assumptions; template clones violate independence.', wallClockMs: Math.round(performance.now()-started), development: runGroup(scoredHand), generated: runGroup(scoredGenerated), holdout: scoredHoldout };
  const json = JSON.stringify(record, null, 2) + '\n';
  const md = `# Synthetic evaluation · ${record.evaluationStage}\n\n- Dataset SHA-256: \`${datasetHash}\`\n- Engine build SHA: \`${sourceSha}\`\n- Engine: ${record.engineVersion}; policy revision ${record.policyRevision}; seed ${SEED}; run ${record.wallClockMs} ms\n- Caveat: ${record.uncertaintyCaveat}\n- Duplicate-family caveat: ${record.generatedFamilyCaveat}\n\n| Split | Cases | Sensitive | Benign | Ambiguous | Prompt precision | Prompt recall | Entity recall | FPR | False block | Benign prevented | Redaction residual |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${[['Development',record.development],['Generated',record.generated],...(record.holdout?[['Holdout',record.holdout]]:[])].map(([label,g])=>`| ${label} | ${g.n} | ${g.truthCounts.SENSITIVE} | ${g.truthCounts.BENIGN} | ${g.truthCounts.AMBIGUOUS} | ${g.metrics.prompt.precision.display} | ${g.metrics.prompt.recall.display} | ${g.metrics.entities.recall.display} | ${g.metrics.prompt.falsePositiveRate.display} | ${g.metrics.benign.falseBlockRate.display} | ${g.metrics.benign.benignPreventedRate.display} | ${g.metrics.redaction.residualRate.display} |`).join('\n')}\n\nNo raw fixture text or matched values are included.\n`;
  await writeFile(resolve(here, HOLDOUT ? 'report-holdout.json' : 'report.json'), json, 'utf8');
  await writeFile(resolve(here, HOLDOUT ? 'report-holdout.md' : 'report.md'), md, 'utf8');
  process.stdout.write(md);
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\','/')}` || process.argv[1]?.endsWith('eval.mjs')) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const HOLDOUT = process.argv.includes('--holdout');
const RUN_QUALITY_GATE = process.argv.includes('--quality-gate');
const SEED = 17017;
const REGRESSION_THRESHOLDS = Object.freeze({
  minimumPromptPrecision: 0.90,
  minimumPromptRecall: 0.95,
  maximumBenignFalseBlockRate: 0.01,
  maximumRedactionResidualRate: 0,
  maximumUnsafeRedactionReleases: 0,
  maximumP95ScanLatencyMsUpTo10k: 300,
});
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
export function emptyCounts() { return { tp: 0, fp: 0, tn: 0, fn: 0, predictedPositive: 0, actualPositive: 0, benign: 0, benignBlocks: 0, benignWarnings: 0, benignPrevented: 0, ambiguous: 0, ambiguousDetected: 0, ambiguousEscalated: 0, entityExpected: 0, entityMatched: 0, entityPredicted: 0, policyEligible: 0, policyCorrect: 0, redactionEntitiesRequired: 0, redactionResidualEntities: 0, unsafeRedactionReleases: 0, engineFailures: 0 };
}
export function buildMetrics(c = emptyCounts()) {
  const precision = rate(c.tp, c.tp + c.fp), recall = rate(c.tp, c.tp + c.fn);
  const f1den = 2 * c.tp + c.fp + c.fn;
  return {
    prompt: { tp: c.tp, fp: c.fp, tn: c.tn, fn: c.fn, precision, recall, f1: f1den ? { value: 2 * c.tp / f1den, numerator: 2 * c.tp, denominator: f1den, display: `${(200 * c.tp / f1den).toFixed(2)}%` } : { value: null, numerator: 0, denominator: 0, display: 'N/A (0/0)' }, falsePositiveRate: rate(c.fp, c.fp + c.tn) },
    benign: { evaluated: c.benign, falseBlockRate: rate(c.benignBlocks, c.benign), falseWarningRate: rate(c.benignWarnings, c.benign), benignPreventedRate: rate(c.benignPrevented, c.benign), falseBlockWilson95Upper: wilsonUpper(c.benignBlocks, c.benign) },
    ambiguous: { excludedFromBinaryMetrics: c.ambiguous, detected: c.ambiguousDetected, escalated: c.ambiguousEscalated },
    entities: { expected: c.entityExpected, matched: c.entityMatched, predicted: c.entityPredicted, precision: rate(c.entityMatched, c.entityPredicted), recall: rate(c.entityMatched, c.entityExpected) },
    perCategory: Object.fromEntries(Object.entries(c.perCategory ?? {}).sort(([a],[b])=>a.localeCompare(b)).map(([category,value])=>[category,{expected:value.expected,matched:value.matched,predicted:value.predicted,recall:rate(value.matched,value.expected),precision:rate(value.matched,value.predicted)}])),
    policy: { eligible: c.policyEligible, exactActionMatches: c.policyCorrect, correctness: rate(c.policyCorrect, c.policyEligible) },
    redaction: { entitiesRequired: c.redactionEntitiesRequired, residualEntities: c.redactionResidualEntities, residualRate: rate(c.redactionResidualEntities, c.redactionEntitiesRequired), unsafeRedactionReleases: c.unsafeRedactionReleases },
    engineFailures: c.engineFailures,
  };
}
export const DUPLICATE_FAMILY_CAVEAT = 'Examples within a template family may be correlated. Reported bootstrap intervals resample whole families, not rows; they describe variation across the represented synthetic families and are not evidence of real-world accuracy.';
export function addCase(c, row, outcome) {
  const findings = outcome?.analysis?.detection?.findings ?? [];
  const detected = findings.some(f => CATEGORIES.has(f.category));
  const action = outcome?.analysis?.decision?.action ?? 'FAILED_SAFE';
  const blocked = action === 'BLOCK';
  const prevented = blocked || action === 'FAILED_SAFE';
  if (row.truth === 'AMBIGUOUS') {
    c.ambiguous++; c.ambiguousDetected += Number(detected); c.ambiguousEscalated += Number(['WARN','REDACT','BLOCK','FAILED_SAFE'].includes(action));
  } else {
    if (row.truth === 'BENIGN') { c.benign++; c.benignBlocks += Number(blocked); c.benignWarnings += Number(action === 'WARN'); c.benignPrevented += Number(prevented); }
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

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6D2B79F5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rateValue(numerator, denominator) { return denominator > 0 ? numerator / denominator : null; }
function familyMetricValues(counts) {
  return {
    promptPrecision: rateValue(counts.tp, counts.tp + counts.fp),
    promptRecall: rateValue(counts.tp, counts.tp + counts.fn),
    falsePositiveRate: rateValue(counts.fp, counts.fp + counts.tn),
    falseBlockRate: rateValue(counts.benignBlocks, counts.benign),
    falseWarningRate: rateValue(counts.benignWarnings, counts.benign),
    entityPrecision: rateValue(counts.entityMatched, counts.entityPredicted),
    entityRecall: rateValue(counts.entityMatched, counts.entityExpected),
    redactionResidualRate: rateValue(counts.redactionResidualEntities, counts.redactionEntitiesRequired),
  };
}

export function familyClusterBootstrap95(families, { replicates = 2000, seed = SEED } = {}) {
  const clusters = Object.values(families);
  if (!Number.isInteger(replicates) || replicates < 100 || replicates > 100000) throw new RangeError('replicates must be an integer from 100 to 100000');
  if (!clusters.length) return { method: 'family_cluster_percentile', clusters: 0, replicates, intervals: {} };
  const random = mulberry32(seed);
  const values = Object.fromEntries(Object.keys(familyMetricValues(emptyCounts())).map(key => [key, []]));
  for (let r = 0; r < replicates; r++) {
    const sample = emptyCounts();
    for (let i = 0; i < clusters.length; i++) {
      const picked = clusters[Math.floor(random() * clusters.length)];
      for (const [key, value] of Object.entries(picked.counts)) {
        if (typeof value === 'number') sample[key] = (sample[key] ?? 0) + value;
      }
    }
    for (const [metric, value] of Object.entries(familyMetricValues(sample))) if (value !== null) values[metric].push(value);
  }
  const observed = emptyCounts();
  for (const family of clusters) for (const [key, value] of Object.entries(family.counts)) {
    if (typeof value === 'number') observed[key] = (observed[key] ?? 0) + value;
  }
  const observedValues = familyMetricValues(observed);
  const quantile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  const intervals = {};
  for (const [metric, sample] of Object.entries(values)) {
    const sorted = sample.sort((a, b) => a - b);
    intervals[metric] = observedValues[metric] === null || !sorted.length ? null : {
      lower95: quantile(sorted, 0.025), upper95: quantile(sorted, 0.975), validReplicates: sorted.length,
    };
  }
  return { method: 'family_cluster_percentile', clusters: clusters.length, replicates, intervals };
}

export function assertDisjointHoldout(holdout, developmentRows) {
  const developmentFamilies = new Set(developmentRows.map(row => row.templateFamily));
  const developmentTexts = new Set(developmentRows.map(row => createHash('sha256').update(row.text.normalize('NFC')).digest('hex')));
  if (holdout.some(row => developmentFamilies.has(row.templateFamily))) throw new Error('holdout template families overlap development data');
  if (holdout.some(row => developmentTexts.has(createHash('sha256').update(row.text.normalize('NFC')).digest('hex')))) throw new Error('holdout texts overlap development data');
}

function evaluateRegressionGate(groups) {
  const checks = [];
  const check = (split, metric, actual, operator, threshold) => {
    const passed = typeof actual === 'number' && Number.isFinite(actual)
      && (operator === 'at_least' ? actual >= threshold : actual <= threshold);
    checks.push({ split, metric, actual: actual ?? null, operator, threshold, passed });
  };
  for (const [split, group] of groups) {
    check(split, 'promptPrecision', group.metrics.prompt.precision.value, 'at_least', REGRESSION_THRESHOLDS.minimumPromptPrecision);
    check(split, 'promptRecall', group.metrics.prompt.recall.value, 'at_least', REGRESSION_THRESHOLDS.minimumPromptRecall);
    check(split, 'benignFalseBlockRate', group.metrics.benign.falseBlockRate.value, 'at_most', REGRESSION_THRESHOLDS.maximumBenignFalseBlockRate);
    check(split, 'redactionResidualRate', group.metrics.redaction.residualRate.value, 'at_most', REGRESSION_THRESHOLDS.maximumRedactionResidualRate);
    check(split, 'unsafeRedactionReleases', group.metrics.redaction.unsafeRedactionReleases, 'at_most', REGRESSION_THRESHOLDS.maximumUnsafeRedactionReleases);
  }
  const generated = groups.find(([split]) => split === 'generated')?.[1];
  for (const [bucket, label] of [['lt_1k', 'under1k'], ['1k_to_10k', '1kTo10k']]) {
    const latency = generated?.latencyByInputLength[bucket];
    check('generated', `p95ScanLatencyMs_${label}`, latency?.runs ? latency.p95Ms : null,
      'at_most', REGRESSION_THRESHOLDS.maximumP95ScanLatencyMsUpTo10k);
  }
  return {
    status: checks.every(({ passed }) => passed) ? 'PASS' : 'FAIL',
    scope: 'synthetic regression only; not production accuracy or release evidence',
    thresholds: REGRESSION_THRESHOLDS,
    checks,
  };
}

async function lines(name) { return readFile(resolve(here, name), 'utf8'); }
function canonicalJson(value) {
  const sort = input => Array.isArray(input) ? input.map(sort)
    : input && typeof input === 'object' ? Object.fromEntries(Object.keys(input).sort().map(key => [key, sort(input[key])]))
      : input;
  return JSON.stringify(sort(value));
}
function insideDirectory(path, directory) {
  const rel = relative(resolve(directory), resolve(path));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel));
}
async function hashTree(root) {
  const files = [];
  async function collect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await collect(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await collect(root);
  files.sort();
  const hash = createHash('sha256');
  for (const path of files) hash.update(path.slice(root.length).replaceAll('\\', '/')).update('\0').update(await readFile(path)).update('\0');
  return hash.digest('hex');
}
async function main() {
  const started = performance.now();
  const hand = parseJsonl(await lines('hand-authored.jsonl'), 'hand-authored');
  const generated = parseJsonl(await lines('generated.jsonl'), 'generated');
  const holdoutCandidates = parseJsonl(await lines('holdout-candidates.jsonl'), 'holdout candidates');
  const gitRevision = process.env.ENGINE_SHA || execFileSync('git', ['rev-parse','HEAD'], { cwd: resolve(here,'../..'), encoding:'utf8' }).trim();
  if (hand.filter(x => x.split === 'train_dev').length < 120) fail('expected at least 120 hand-authored development cases');
  if (generated.length < 1000 || generated.filter(x => x.truth === 'BENIGN').length < 150) fail('generated minimum not met');
  if (holdoutCandidates.length < 30) fail('expected at least 30 holdout candidates');
  let holdout = [];
  let holdoutRaw = null;
  let verifiedAttestation = null;
  if (HOLDOUT) {
    const holdoutDirectory = process.env.EVAL_HOLDOUT_DIR;
    if (!holdoutDirectory || insideDirectory(holdoutDirectory, repoRoot)) fail('set EVAL_HOLDOUT_DIR to an external sealed directory; labeled holdout files must stay outside the repository');
    let attestationRaw;
    try {
      holdoutRaw = await readFile(resolve(holdoutDirectory, 'holdout.jsonl'), 'utf8');
      attestationRaw = await readFile(resolve(holdoutDirectory, 'holdout-attestation.json'), 'utf8');
    } catch { fail('external independent frozen holdout or reviewer attestation is missing; no holdout result was produced'); }
    holdout = parseJsonl(holdoutRaw, 'holdout');
    let attestation; try { attestation=JSON.parse(attestationRaw); } catch { fail('holdout attestation is not valid JSON'); }
    const holdoutHash = createHash('sha256').update(holdoutRaw).digest('hex');
    const developmentRows = [...hand.filter(row => row.split === 'train_dev'), ...generated];
    let holdoutDisjoint = true;
    try { assertDisjointHoldout(holdout, developmentRows); } catch { holdoutDisjoint = false; }
    if (!process.env.DETECTOR_AUTHOR_ID || !process.env.EVALUATOR_ID || process.env.DETECTOR_AUTHOR_ID === process.env.EVALUATOR_ID) fail('set distinct DETECTOR_AUTHOR_ID and EVALUATOR_ID before holdout scoring');
    const reviewerIsAuthor = attestation.reviewerId === process.env.DETECTOR_AUTHOR_ID;
    const reviewerIsOperator = attestation.reviewerId === process.env.EVALUATOR_ID;
    const releaseSha = process.env.RELEASE_ENGINE_SHA;
    const attestationKeys = Object.keys(attestation).sort().join('|');
    const reviewerPublicKeyPath = process.env.HOLDOUT_REVIEWER_PUBLIC_KEY_FILE;
    const expectedReviewerId = process.env.HOLDOUT_REVIEWER_ID;
    let reviewerKeyId = null;
    let signatureValid = false;
    if (reviewerPublicKeyPath && !insideDirectory(reviewerPublicKeyPath, repoRoot)) {
      try {
        const key = createPublicKey(await readFile(reviewerPublicKeyPath));
        if (key.asymmetricKeyType === 'ed25519') {
          reviewerKeyId = createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
          const { signature, ...unsignedAttestation } = attestation;
          const decodedSignature = typeof signature === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(signature) ? Buffer.from(signature, 'base64') : Buffer.alloc(0);
          signatureValid = attestation.algorithm === 'Ed25519'
            && attestation.reviewerKeyId === reviewerKeyId
            && decodedSignature.length === 64
            && verifySignature(null, Buffer.from(canonicalJson(unsignedAttestation)), key, decodedSignature);
        }
      } catch { signatureValid = false; }
    }
    const truthCounts = Object.fromEntries(['SENSITIVE','BENIGN','AMBIGUOUS'].map(truth => [truth, holdout.filter(row => row.truth === truth).length]));
    const holdoutFamilies = new Set(holdout.map(row => row.templateFamily));
    const classBalanceValid = truthCounts.SENSITIVE >= 10 && truthCounts.BENIGN >= 10 && truthCounts.AMBIGUOUS >= 5;
    if (attestationKeys !== 'algorithm|releaseSha|reviewedAt|reviewerId|reviewerKeyId|sha256|signature' || attestation.algorithm !== 'Ed25519'
      || holdout.length < 30 || holdoutFamilies.size < 10 || !classBalanceValid
      || holdout.some(row => row.split !== 'holdout' || row.source !== 'independent_human') || !holdoutDisjoint
      || !attestation.reviewerId || attestation.reviewerId === 'PENDING' || attestation.reviewerId !== expectedReviewerId
      || reviewerIsAuthor || reviewerIsOperator || !signatureValid
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(attestation.reviewedAt ?? '')
      || !Number.isFinite(Date.parse(attestation.reviewedAt)) || attestation.sha256 !== holdoutHash
      || attestation.releaseSha !== releaseSha || !/^[0-9a-f]{40}$/i.test(releaseSha ?? '') || gitRevision !== releaseSha) {
      fail('holdout requires independently authored rows, class/family minimums, disjoint texts/families, a valid Ed25519 reviewer signature, distinct reviewer identity, and the exact frozen engine SHA');
    }
    verifiedAttestation = { reviewerId: attestation.reviewerId, reviewerKeyId, releaseSha: attestation.releaseSha, signatureVerified: true };
  }
  const corpusFiles = ['hand-authored.jsonl', 'generated.jsonl', 'holdout-candidates.jsonl'];
  const corpusParts = await Promise.all(corpusFiles.map(async name => `${name}\n${await lines(name)}`));
  if (HOLDOUT) corpusParts.push(`external-holdout.jsonl\n${holdoutRaw}`);
  const datasetHash = createHash('sha256').update(corpusParts.join('\n--dataset-file--\n')).digest('hex');
  const evaluationCodeSha256 = createHash('sha256').update(await lines('eval.mjs')).digest('hex');
  const corpusGeneratorSha256 = createHash('sha256').update(await lines('prepare-corpus.mjs')).digest('hex');
  const engineDir = process.env.EVAL_ENGINE_DIR ? resolve(here, process.env.EVAL_ENGINE_DIR) : resolve(here, '../../packages/engine/dist');
  const engineSourceSha256 = await hashTree(resolve(here, '../../packages/engine/src'));
  const engineBuildSha256 = await hashTree(engineDir);
  let engine;
  try { engine = await import(pathToFileURL(join(engineDir,'index.js')).href); } catch { fail('built engine missing; run npm run build:engine from repository root or set EVAL_ENGINE_DIR to an equivalent frozen build'); }
  const { analyze } = engine;
  const { DEFAULT_POLICY } = await import(pathToFileURL(join(engineDir,'default-policy.js')).href);
  const EVALUATION_POLICY = { ...DEFAULT_POLICY, protectedTerms: ['Project Cobalt Harbor'] };
  const runGroup = (rows) => {
    const total = emptyCounts(), families = new Map(), latencySamples = [];
    for (const row of rows) {
      const scanStarted = performance.now();
      let outcome;
      try { outcome = { analysis: analyze({ text: row.text, policy: EVALUATION_POLICY }) }; }
      catch (error) { outcome = { analysis: null }; }
      latencySamples.push({ inputLength: row.text.length, milliseconds: performance.now() - scanStarted });
      addCase(total, row, outcome);
      const family = row.templateFamily || 'unspecified';
      if (!families.has(family)) families.set(family, emptyCounts());
      addCase(families.get(family), row, outcome);
    }
    const templateFamilies = Object.fromEntries([...families].sort(([a],[b]) => a.localeCompare(b)).map(([key,value]) => [key,{n:rows.filter(row=>row.templateFamily===key).length,counts:value,metrics:buildMetrics(value)}]));
    const latencyByInputLength = {};
    for (const [bucket, include] of [['lt_1k', length => length < 1000], ['1k_to_10k', length => length >= 1000 && length <= 10000], ['gt_10k', length => length > 10000]]) {
      const values = latencySamples.filter(sample => include(sample.inputLength)).map(sample => sample.milliseconds).sort((a,b)=>a-b);
      if (!values.length) { latencyByInputLength[bucket] = { runs: 0, p50Ms: null, p95Ms: null }; continue; }
      const percentile = p => values[Math.min(values.length - 1, Math.ceil(p * values.length) - 1)];
      latencyByInputLength[bucket] = { runs: values.length, p50Ms: Number(percentile(0.5).toFixed(3)), p95Ms: Number(percentile(0.95).toFixed(3)) };
    }
    return { n: rows.length, truthCounts: Object.fromEntries(['SENSITIVE','BENIGN','AMBIGUOUS'].map(truth => [truth, rows.filter(row => row.truth === truth).length])), metrics: buildMetrics(total), latencyByInputLength, familyClusterBootstrap95: familyClusterBootstrap95(templateFamilies), templateFamilies };
  };
  const scoredHand = hand.filter(row => row.split === 'train_dev');
  const scoredGenerated = generated;
  const scoredHoldout = HOLDOUT ? runGroup(holdout) : null;
  const unsealedHoldoutCandidates = {
    status: 'UNSEALED_REQUIRES_INDEPENDENT_REVIEW',
    rows: holdoutCandidates.length,
    templateFamilies: new Set(holdoutCandidates.map(row => row.templateFamily)).size,
    truthCounts: Object.fromEntries(['SENSITIVE','BENIGN','AMBIGUOUS'].map(truth => [truth, holdoutCandidates.filter(row => row.truth === truth).length])),
    categories: [...new Set(holdoutCandidates.flatMap(row => row.expectedEntities.map(entity => entity.category)))].sort(),
  };
  const engineVersion = analyze({text:'',policy:EVALUATION_POLICY}).detection.engineVersion;
  const development = runGroup(scoredHand);
  const generatedResult = runGroup(scoredGenerated);
  const record = { reportVersion: 'v2', evaluationStage: HOLDOUT ? 'sealed-holdout' : 'development-current-branch', releaseReady: HOLDOUT, datasetHash, evaluationCodeSha256, corpusGeneratorSha256, engineGitRevision: gitRevision, engineSourceSha256, engineBuildSha256, engineVersion, policyRevision: EVALUATION_POLICY.revision, evaluationPolicy: { protectedTermCount: EVALUATION_POLICY.protectedTerms.length, protectedTermsIncludedInReport: false }, holdoutAttestation: verifiedAttestation, splitMethodology: { development: 'hand-authored train_dev; template-generated stress set reported separately', holdout: 'externally stored human-authored corpus with Ed25519 reviewer attestation bound to the exact release SHA; exact-text and family disjointness verified' }, unsealedHoldoutCandidates, randomSeed: SEED, generatedFamilyCaveat: DUPLICATE_FAMILY_CAVEAT, uncertaintyCaveat: 'Synthetic metrics are not production accuracy. Percentile intervals use a deterministic family-cluster bootstrap; small or homogeneous family counts can still give misleadingly narrow intervals. Scan timing measures only synchronous engine analysis in the Node runner, not browser messaging, UI overhead, or a range of hardware.', wallClockMs: Math.round(performance.now()-started), development, generated: generatedResult, holdout: scoredHoldout };
  const gateGroups = [['development', development], ['generated', generatedResult], ...(scoredHoldout ? [['holdout', scoredHoldout]] : [])];
  record.qualityGate = evaluateRegressionGate(gateGroups);
  const json = JSON.stringify(record, null, 2) + '\n';
  const md = `# Synthetic evaluation · ${record.evaluationStage}\n\n- Dataset SHA-256: \`${datasetHash}\`\n- Engine Git revision: \`${gitRevision}\`\n- Engine source SHA-256: \`${engineSourceSha256}\`\n- Engine build SHA-256: \`${engineBuildSha256}\`\n- Engine: ${record.engineVersion}; policy revision ${record.policyRevision}; seed ${SEED}; run ${record.wallClockMs} ms\n- Evaluation policy: one fixed synthetic owner-protected term; the term itself is omitted from the report.\n- Caveat: ${record.uncertaintyCaveat}\n- Duplicate-family caveat: ${record.generatedFamilyCaveat}\n\n| Split | Cases | Sensitive | Benign | Ambiguous | Prompt precision | Prompt recall | Entity recall | FPR | False warning | False block | Redaction residual |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${[['Development',record.development],['Generated',record.generated],...(record.holdout?[['Holdout',record.holdout]]:[])].map(([label,g])=>`| ${label} | ${g.n} | ${g.truthCounts.SENSITIVE} | ${g.truthCounts.BENIGN} | ${g.truthCounts.AMBIGUOUS} | ${g.metrics.prompt.precision.display} | ${g.metrics.prompt.recall.display} | ${g.metrics.entities.recall.display} | ${g.metrics.prompt.falsePositiveRate.display} | ${g.metrics.benign.falseWarningRate.display} | ${g.metrics.benign.falseBlockRate.display} | ${g.metrics.redaction.residualRate.display} |`).join('\n')}\n\n| Split | <1k p95 (ms) | 1k–10k p95 (ms) | >10k p95 (ms) |\n|---|---:|---:|---:|\n${[['Development',record.development],['Generated',record.generated],...(record.holdout?[['Holdout',record.holdout]]:[])].map(([label,g])=>`| ${label} | ${g.latencyByInputLength.lt_1k.runs ? g.latencyByInputLength.lt_1k.p95Ms : 'N/A'} | ${g.latencyByInputLength['1k_to_10k'].runs ? g.latencyByInputLength['1k_to_10k'].p95Ms : 'N/A'} | ${g.latencyByInputLength.gt_10k.runs ? g.latencyByInputLength.gt_10k.p95Ms : 'N/A'} |`).join('\n')}\n\nNo raw fixture text or matched values are included.\n`;
  await writeFile(resolve(here, HOLDOUT ? 'report-holdout.json' : 'report.json'), json, 'utf8');
  const ciText = (value) => value ? `${(100 * value.lower95).toFixed(2)}%–${(100 * value.upper95).toFixed(2)}%` : 'N/A';
  const bootstrapGroups = [['Development',record.development],['Generated',record.generated],...(record.holdout?[['Holdout',record.holdout]]:[])];
  const bootstrapMd = `\n## Family-cluster bootstrap intervals\n\nDeterministic percentile bootstrap; resampling unit is the template family (2,000 replicates, seed ${SEED}). These intervals quantify only variability across the listed synthetic families.\n\n| Split | Families | Prompt precision 95% interval | Prompt recall 95% interval | Entity precision 95% interval | Entity recall 95% interval | False block 95% interval | Redaction residual 95% interval |\n|---|---:|---:|---:|---:|---:|---:|---:|\n${bootstrapGroups.map(([label,g])=>{const ci=g.familyClusterBootstrap95.intervals;return `| ${label} | ${g.familyClusterBootstrap95.clusters} | ${ciText(ci.promptPrecision)} | ${ciText(ci.promptRecall)} | ${ciText(ci.entityPrecision)} | ${ciText(ci.entityRecall)} | ${ciText(ci.falseBlockRate)} | ${ciText(ci.redactionResidualRate)} |`;}).join('\n')}\n`;
  const falseWarningMd = `\nFalse-warning 95% family-cluster intervals: ${bootstrapGroups.map(([label,g])=>`${label} ${ciText(g.familyClusterBootstrap95.intervals.falseWarningRate)}`).join('; ')}.\n`;
  const provenanceMd = `\n- Evaluation code SHA-256: \`${evaluationCodeSha256}\`\n- Corpus generator SHA-256: \`${corpusGeneratorSha256}\`\n- Split methodology: ${record.splitMethodology.development}; holdout requires independent human authoring, external sealed storage, a verified Ed25519 reviewer signature, and exact-text plus family disjointness.\n${verifiedAttestation ? `- Holdout reviewer: \`${verifiedAttestation.reviewerId}\`; key fingerprint: \`${verifiedAttestation.reviewerKeyId}\`; release SHA: \`${verifiedAttestation.releaseSha}\`; signature verified.\n` : ''}- Unsealed holdout candidate pool: ${unsealedHoldoutCandidates.rows} rows across ${unsealedHoldoutCandidates.templateFamilies} template families; labels ${unsealedHoldoutCandidates.categories.join(', ')}; not scored or release evidence.\n`;
  const qualityGateMd = `\n## Synthetic regression gate\n\nStatus: **${record.qualityGate.status}**${RUN_QUALITY_GATE ? ' (enforced for this run)' : ' (reported; pass `--quality-gate` to enforce)'}\n\nThresholds: prompt precision ≥ ${(100 * REGRESSION_THRESHOLDS.minimumPromptPrecision).toFixed(0)}%; prompt recall ≥ ${(100 * REGRESSION_THRESHOLDS.minimumPromptRecall).toFixed(0)}%; benign false-block rate ≤ ${(100 * REGRESSION_THRESHOLDS.maximumBenignFalseBlockRate).toFixed(0)}%; redaction residual rate and unsafe releases = 0; generated-set p95 scan latency for inputs up to 10,000 characters ≤ ${REGRESSION_THRESHOLDS.maximumP95ScanLatencyMsUpTo10k} ms. This synthetic regression gate is not independent release evidence.\n`;
  const report = md + qualityGateMd + bootstrapMd + falseWarningMd + provenanceMd;
  await writeFile(resolve(here, HOLDOUT ? 'report-holdout.md' : 'report.md'), report, 'utf8');
  process.stdout.write(report);
  if (RUN_QUALITY_GATE && record.qualityGate.status !== 'PASS') {
    const failures = record.qualityGate.checks.filter(({ passed }) => !passed)
      .map(({ split, metric, actual, operator, threshold }) => `${split}.${metric}=${actual ?? 'N/A'} (${operator} ${threshold})`);
    throw new Error(`Synthetic regression gate failed: ${failures.join('; ')}`);
  }
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\','/')}` || process.argv[1]?.endsWith('eval.mjs')) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

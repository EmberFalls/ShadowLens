import test from 'node:test';
import assert from 'node:assert/strict';
import { addCase, buildMetrics, DUPLICATE_FAMILY_CAVEAT, emptyCounts, maximumEntityMatches, parseJsonl, validateRecord, wilsonUpper } from './eval.mjs';

const entity = (category,start,end,value) => ({category,start,end,value});
const record = ({truth='SENSITIVE',text='person@shop.invalid',expectedEntities=[entity('PII_EMAIL',0,19,'person@shop.invalid')],expectedAction='REDACT',templateFamily='family-a'}={}) => ({id:'hand_0001',split:'train_dev',source:'hand_authored',text,truth,composition:'SINGLE',supportedScope:'SANDBOX_TEXT',expectedEntities,expectedAction,tags:[],templateFamily,notes:''});
const fakeFinding = (category,start,end) => ({category,start,end});
const outcome = (findings=[],action='ALLOW',replacementOperations=[]) => ({analysis:{detection:{findings},decision:{action,replacementOperations}}});

test('one prompt with two expected entities and one miss has entity recall 1/2', () => {
  const expected=[entity('PII_EMAIL',0,19,'person@shop.invalid'),entity('PII_PHONE',25,35,'9876543210')];
  const predicted=[fakeFinding('PII_EMAIL',0,19)];
  assert.equal(maximumEntityMatches(expected,predicted),1);
});

test('all-ambiguous split is excluded from confusion metrics', () => {
  const counts=emptyCounts();
  addCase(counts,record({truth:'AMBIGUOUS',expectedEntities:[],expectedAction:'WARN'}),outcome([], 'WARN'));
  const metrics=buildMetrics(counts);
  assert.equal(metrics.ambiguous.excludedFromBinaryMetrics,1);
  assert.deepEqual([metrics.prompt.tp,metrics.prompt.fp,metrics.prompt.tn,metrics.prompt.fn],[0,0,0,0]);
  assert.equal(metrics.prompt.precision.display,'N/A (0/0)');
});

test('zero denominators are N/A and Wilson bound is undefined at n=0', () => {
  const metrics=buildMetrics(emptyCounts());
  assert.equal(metrics.entities.recall.value,null);
  assert.equal(metrics.benign.falseBlockRate.display,'N/A (0/0)');
  assert.equal(wilsonUpper(0,0),null);
});

test('intentional false positive on a benign row increments FPR', () => {
  const counts=emptyCounts();
  addCase(counts,record({truth:'BENIGN',text:'example only',expectedEntities:[],expectedAction:'ALLOW'}),outcome([fakeFinding('PII_EMAIL',0,5)],'REDACT'));
  const metrics=buildMetrics(counts);
  assert.equal(metrics.prompt.falsePositiveRate.display,'100.00% (1/1)');
  assert.equal(metrics.benign.falseBlockRate.display,'0.00% (0/1)');
});

test('one benign BLOCK counts as false block and prevented release', () => {
  const counts=emptyCounts();
  addCase(counts,record({truth:'BENIGN',text:'hello',expectedEntities:[],expectedAction:'ALLOW'}),outcome([], 'BLOCK'));
  const metrics=buildMetrics(counts);
  assert.equal(metrics.benign.falseBlockRate.display,'100.00% (1/1)');
  assert.equal(metrics.benign.benignPreventedRate.display,'100.00% (1/1)');
  assert.ok(metrics.benign.falseBlockWilson95Upper > 0.5);
});

test('duplicate template families carry an explicit dependence caveat', () => {
  const one=record({text:'person@shop.invalid'});
  const familyRows=[one,{...one,id:'hand_0002',text:'other@shop.invalid',templateFamily:'family-a'}];
  assert.equal(new Set(familyRows.map(row=>row.templateFamily)).size,1);
  assert.ok('templateFamily' in familyRows[0]);
  assert.match(DUPLICATE_FAMILY_CAVEAT,/family-cluster bootstrap/);
  assert.ok(parseJsonl(JSON.stringify(familyRows[0]),'test').length===1);
});

test('strict validator rejects drift and incorrect annotation offsets', () => {
  const valid=record();
  assert.equal(validateRecord(valid).id,'hand_0001');
  assert.throws(()=>validateRecord({...valid,extra:'not allowed'}),/keys do not match/);
  assert.throws(()=>validateRecord({...valid,expectedEntities:[entity('PII_EMAIL',1,19,'not the expected span')]}),/annotation value does not match/);
});

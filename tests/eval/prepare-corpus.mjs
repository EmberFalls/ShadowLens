import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SEED = 17017;
let state = SEED >>> 0;
function rand() { state = (1664525 * state + 1013904223) >>> 0; return state / 0x100000000; }
function pick(values) { return values[Math.floor(rand() * values.length)]; }
const first = ['Asha','Ravi','Mina','Dev','Ira','Kabir','Tara','Neel','Zoya','Arun','Nila','Kian','Rhea','Omar','Lina','Ishan','Mira','Sana','Avi','Noor'];
const last = ['Sen','Rao','Das','Shah','Nair','Iyer','Khan','Mehta','Roy','Patel','Dutta','Bose','Kapoor','Jain','Ali','Menon'];
const benign = [
  ['A short note says hello and asks for a meeting next week.','ordinary prose'],
  ['The test uses api_key=NOT_A_REAL_KEY as a documented placeholder.','credential hard negative'],
  ['Numbers 1234567890 and 0000000000 are examples, not contacts.','numeric hard negative'],
  ['Unicode check: नमस्ते, café, 東京, and 🙂 should remain unchanged.','unicode benign'],
  ['SELECT name FROM demo_table WHERE active = true;','code shape'],
  ['name,email\nSample,not-an-address\nOther,none','multiline csv hard negative'],
  ['Please summarize this public product description without personal details.','ordinary request'],
  ['The word token appears in this sentence as a common noun.','credential vocabulary hard negative'],
  ['कृपया इस छोटे वाक्य का सार बताएं।','mixed language benign'],
  ['The placeholder <EMAIL> is a schema label, not an address.','entity placeholder'],
];
const categories = ['SENSITIVE','SENSITIVE','SENSITIVE','SENSITIVE','SENSITIVE','BENIGN','BENIGN','BENIGN','AMBIGUOUS','AMBIGUOUS'];
function row({ id, split, source, text, truth, composition='SINGLE', expectedEntities=[], expectedAction, templateFamily, tags=[], notes='' }) {
  return { id, split, source, text, truth, composition, supportedScope:'SANDBOX_TEXT', expectedEntities, expectedAction, tags, templateFamily, notes };
}
function emailCase({ id, split, source, mixed=false, index=0, family='email_plain', context='' }) {
  const address = `${pick(first).toLowerCase()}.${pick(last).toLowerCase()}${index}@mail.invalid`;
  const prefix = mixed ? `Demo row ${index}; ${context || 'Please schedule the fictional record for next week.'} ` : `${context || 'Draft a short local note for a test fixture. '} `;
  const text = `${prefix}contact ${address}`;
  const start = text.indexOf(address);
  return row({ id, split, source, text, truth:'SENSITIVE', composition:mixed?'MIXED':'SINGLE', expectedEntities:[{category:'PII_EMAIL',start,end:start+address.length,value:address}], expectedAction:'REDACT', templateFamily:family, tags:mixed?['mixed_context','synthetic_email']:['synthetic_email'], notes:'Fictional reserved-domain entity.' });
}
const hand = [];
const contexts = [
  'Summarize the fictional test record.',
  'कृपया इस परीक्षण पंक्ति का सार बताएं।',
  'CSV import preview for a fake contact.',
  'Code comment for a local fixture: const contact = value;',
  'Unicode note 🙂 for a synthetic support ticket.',
];
for (let i=0;i<45;i++) hand.push(emailCase({id:`hand_${String(i+1).padStart(4,'0')}`,split:'train_dev',source:'hand_authored',mixed:i>=30,index:i,family:i%5===0?'mixed_multilingual':i%5===1?'multiline_csv_context':i%5===2?'code_context':i%5===3?'unicode_context':'email_plain',context:contexts[i%contexts.length]}));
for (let i=0;i<25;i++) {
  const [text,family]=benign[i%benign.length];
  hand.push(row({id:`hand_${String(i+46).padStart(4,'0')}`,split:'train_dev',source:'hand_authored',text,truth:'BENIGN',expectedAction:'ALLOW',templateFamily:family,tags:['benign','hard_negative'],notes:'Predeclared benign synthetic fixture.'}));
}
for (let i=0;i<20;i++) {
  const text = i%2===0 ? `A fictional incomplete identifier ${['555-01','x@y','4111 1111 1111 1112','ABCDE1234X'][i%4]} appears in a test prompt.` : `Unclear context: ${pick(['Jordan','Taylor','Alex'])} may be an example label; do not infer a real identity.`;
  hand.push(row({id:`hand_${String(i+71).padStart(4,'0')}`,split:'train_dev',source:'hand_authored',text,truth:'AMBIGUOUS',expectedAction:'WARN',templateFamily:i%2===0?'ambiguous_partial_identifier':'ambiguous_name_context',tags:['ambiguous','predeclared_exclusion'],notes:'Ambiguous cases are excluded from binary confusion metrics.'}));
}
for(let i=0;i<15;i++) hand.push(emailCase({id:`hand_${String(i+91).padStart(4,'0')}`,split:'train_dev',source:'hand_authored',mixed:true,index:100+i,family:i%3===0?'hand_mixed_multilingual':i%3===1?'hand_mixed_csv':'hand_mixed_code',context:contexts[(i+1)%contexts.length]}));
for(let i=0;i<10;i++) {
  const [text,family]=benign[(i+6)%benign.length];
  hand.push(row({id:`hand_${String(i+106).padStart(4,'0')}`,split:'train_dev',source:'hand_authored',text,truth:'BENIGN',expectedAction:'ALLOW',templateFamily:`hand_extra_${family}`,tags:['benign','hard_negative'],notes:'Additional predeclared benign synthetic fixture.'}));
}
for(let i=0;i<5;i++) {
  const text=`Unclear test context ${i}: ${['customer?','sample key?','number fragment?','unattributed contact?','fictional name?'][i]}`;
  hand.push(row({id:`hand_${String(i+116).padStart(4,'0')}`,split:'train_dev',source:'hand_authored',text,truth:'AMBIGUOUS',expectedAction:'WARN',templateFamily:'hand_extra_ambiguous',tags:['ambiguous','predeclared_exclusion'],notes:'Predeclared ambiguous exclusion.'}));
}

const candidate = [];
for (let i=0;i<10;i++) candidate.push(emailCase({id:`holdout_${String(i+1).padStart(4,'0')}`,split:'holdout',source:'candidate_pending_review',mixed:i%3===0,index:900+i,family:'holdout_email_candidate',context:contexts[(i+2)%contexts.length]}));
for (let i=0;i<10;i++) {
  const [text,family]=benign[(i+3)%benign.length];
  candidate.push(row({id:`holdout_${String(i+11).padStart(4,'0')}`,split:'holdout',source:'candidate_pending_review',text,truth:'BENIGN',expectedAction:'ALLOW',templateFamily:`holdout_${family}`,tags:['candidate','benign'],notes:'Requires independent human replacement/review before holdout scoring.'}));
}
for (let i=0;i<10;i++) {
  const text=`Uncertain test excerpt ${i}: ${['id ends with 01','token placeholder','approximate phone','incomplete account label','unattributed name'][i%5]}.`;
  candidate.push(row({id:`holdout_${String(i+21).padStart(4,'0')}`,split:'holdout',source:'candidate_pending_review',text,truth:'AMBIGUOUS',expectedAction:'WARN',templateFamily:'holdout_ambiguous_candidate',tags:['candidate','ambiguous'],notes:'Requires independent human replacement/review before holdout scoring.'}));
}
for (let i=0;i<6;i++) {
  const phone = `+91 900000${String(i).padStart(4, '0')}`;
  const text = `Synthetic support fixture phone: ${phone}.`;
  const start = text.indexOf(phone);
  candidate.push(row({id:`holdout_${String(i+31).padStart(4,'0')}`,split:'holdout',source:'candidate_pending_review',text,truth:'SENSITIVE',expectedEntities:[{category:'PII_PHONE',start,end:start+phone.length,value:phone}],expectedAction:'REDACT',templateFamily:'holdout_phone_candidate',tags:['candidate','synthetic_phone'],notes:'Synthetic placeholder; requires independent reviewer validation.'}));
}
for (let i=0;i<6;i++) {
  const token = `sk_test_0123456789abcde${i}`;
  const text = `Synthetic deployment fixture secret=${token}`;
  const start = text.indexOf(token);
  candidate.push(row({id:`holdout_${String(i+37).padStart(4,'0')}`,split:'holdout',source:'candidate_pending_review',text,truth:'SENSITIVE',expectedEntities:[{category:'SECRET_TOKEN',start,end:start+token.length,value:token}],expectedAction:'REDACT',templateFamily:'holdout_token_assignment_candidate',tags:['candidate','synthetic_secret'],notes:'Synthetic placeholder; requires independent reviewer validation.'}));
}
function cardWithValidChecksum(index) {
  const prefix = `400000000000${String(index).padStart(3, '0')}`;
  let sum = 0;
  for (let i=prefix.length-1, double=true; i>=0; i--, double=!double) {
    let digit = Number(prefix[i]);
    if (double) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return `${prefix}${(10 - sum % 10) % 10}`;
}
for (let i=0;i<6;i++) {
  const card = cardWithValidChecksum(i+1);
  const text = `Synthetic payment test number: ${card}`;
  const start = text.indexOf(card);
  candidate.push(row({id:`holdout_${String(i+43).padStart(4,'0')}`,split:'holdout',source:'candidate_pending_review',text,truth:'SENSITIVE',expectedEntities:[{category:'PII_PAYMENT_CARD',start,end:start+card.length,value:card}],expectedAction:'REDACT',templateFamily:'holdout_payment_test_candidate',tags:['candidate','synthetic_payment_test'],notes:'Synthetic test-only number; requires independent reviewer validation.'}));
}
for (let i=0;i<6;i++) {
  const text = `CONFIDENTIAL synthetic planning fixture ${i}.`;
  const marker = 'CONFIDENTIAL';
  const start = text.indexOf(marker);
  candidate.push(row({id:`holdout_${String(i+49).padStart(4,'0')}`,split:'holdout',source:'candidate_pending_review',text,truth:'SENSITIVE',expectedEntities:[{category:'CONFIDENTIAL_MARKER',start,end:start+marker.length,value:marker}],expectedAction:'WARN',templateFamily:'holdout_confidential_marker_candidate',tags:['candidate','synthetic_marker'],notes:'Synthetic marker fixture; requires independent reviewer validation.'}));
}

const generated=[];
const templates=[
  (n,a)=>`Draft a synthetic support note for ${a}; use only fake records.`,
  (n,a)=>`name,email\n${n},${a}\nStatus,example only`,
  (n,a)=>`// fake contact in a code sample\nconst email = "${a}";`,
  (n,a)=>`कृपया परीक्षण करें: ${a} — यह काल्पनिक डेटा है।`,
  (n,a)=>`Unicode fixture 🙂 café 東京; contact=${a}`,
  (n,a)=>`The user label is ${n}. The reserved test address is ${a}.`,
  (n,a)=>`[SYNTHETIC] CSV import preview: ${n},${a},not-a-customer`,
  (n,a)=>`For a test only, write a reply to the fake address ${a}.`,
];
for(let i=0;i<1000;i++) {
  const id=`generated_${String(i+1).padStart(4,'0')}`;
  if(i<200) {
    const [text,family]=benign[i%benign.length];
    generated.push(row({id,split:'generated',source:'template_generator',text,truth:'BENIGN',expectedAction:'ALLOW',templateFamily:`benign_${family}`,tags:['generated','benign','seed_17017'],notes:'Deterministic generated negative; family dependence applies.'}));
  } else {
    const n=`${pick(first)} ${pick(last)} ${i}`;
    const address=`${n.toLowerCase().replaceAll(' ','.')}@example.invalid`;
    const family=`sensitive_${i%templates.length}`;
    const token = `sk_test_${String(i).padStart(10,'0')}abcdef`;
    let text=templates[i%templates.length](n,address);
    if (i%8===6) text=`Local fake credential ${token}; ${text}`;
    if (i%8===7) text=`India contact ${'+91 98765'+String(i).padStart(5,'0')}; ${text}`;
    const start=text.indexOf(address);
    const entities=[{category:'PII_EMAIL',start,end:start+address.length,value:address}];
    if(i%8===6) { const tokenStart=text.indexOf(token); entities.push({category:'SECRET_TOKEN',start:tokenStart,end:tokenStart+token.length,value:token}); }
    if(i%8===7) { const phone='+91 98765'+String(i).padStart(5,'0'); const phoneStart=text.indexOf(phone); entities.push({category:'PII_PHONE',start:phoneStart,end:phoneStart+phone.length,value:phone}); }
    entities.sort((a,b)=>a.start-b.start);
    generated.push(row({id,split:'generated',source:'template_generator',text,truth:'SENSITIVE',composition:i%4===0?'MIXED':'SINGLE',expectedEntities:entities,expectedAction:'REDACT',templateFamily:family,tags:['generated','synthetic_email','seed_17017',...(i%4===0?['mixed_context']:[])],notes:'Deterministic fictional reserved-domain entity; correlated template sample.'}));
  }
}
// Deterministic size-boundary stress cases exercise chunk edges and the
// declared 10,000-character latency target without embedding real data.
for (const [index, targetLength] of [2047, 2048, 2049, 9999, 10000, 10001].entries()) {
  const address = `boundary${index}@example.invalid`;
  const suffix = ` contact ${address}`;
  const filler = 'Synthetic long-context filler. ';
  const prefix = filler.repeat(Math.ceil((targetLength - suffix.length) / filler.length)).slice(0, targetLength - suffix.length);
  const text = prefix + suffix;
  const start = text.indexOf(address);
  generated.push(row({
    id: `generated_${String(1001 + index).padStart(4, '0')}`,
    split: 'generated', source: 'template_generator', text, truth: 'SENSITIVE',
    expectedEntities: [{ category: 'PII_EMAIL', start, end: start + address.length, value: address }],
    expectedAction: 'REDACT', templateFamily: `boundary_length_${targetLength}`,
    tags: ['generated', 'size_boundary'], notes: `Synthetic exact-length scanner stress fixture (${targetLength} UTF-16 units).`,
  }));
}
const jsonl = rows => rows.map(item=>JSON.stringify(item)).join('\n')+'\n';
await Promise.all([
  writeFile(resolve(here,'hand-authored.jsonl'),jsonl(hand),'utf8'),
  writeFile(resolve(here,'holdout-candidates.jsonl'),jsonl(candidate),'utf8'),
  writeFile(resolve(here,'generated.jsonl'),jsonl(generated),'utf8'),
]);
process.stdout.write(`Prepared ${hand.length} hand-authored candidates (${hand.filter(r=>r.truth==='SENSITIVE').length} sensitive, ${hand.filter(r=>r.truth==='BENIGN').length} benign, ${hand.filter(r=>r.truth==='AMBIGUOUS').length} ambiguous), ${candidate.length} holdout candidates (unsealed), and ${generated.length} generated rows (${generated.filter(r=>r.truth==='BENIGN').length} benign); seed ${SEED}.\n`);

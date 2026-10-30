import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

class Element {
  constructor(id) { this.id=id; this.value=''; this.textContent=''; this.hidden=false; this.children=[]; this.listeners=new Map(); }
  addEventListener(type, listener) { const list=this.listeners.get(type)??[]; list.push(listener); this.listeners.set(type,list); }
  append(child) { this.children.push(child); }
  replaceChildren() { this.children=[]; }
  dispatch(type,event={}) { for(const listener of this.listeners.get(type)??[]) listener({preventDefault(){this.prevented=true;},...event}); }
}
function harness() {
  const ids=['#shadow-composer','#shadow-received','#empty','#coverage','#shadow-send','#clear'];
  const elements=Object.fromEntries(ids.map(id=>[id,new Element(id)]));
  const document={
    documentElement:{dataset:{shadowshieldCoverage:'UNPROTECTED'}},
    querySelector(selector){return elements[selector];},
    createElement(){return new Element('li');},
    dispatches:[],
    dispatchEvent(event){this.dispatches.push({event,count:elements['#shadow-received'].children.length});},
  };
  const networkCalls=[]; const storageCalls=[];
  const observers=[];
  class FakeCustomEvent { constructor(type,init={}){this.type=type;this.detail=init.detail;} }
  class FakeMutationObserver { constructor(callback){this.callback=callback;observers.push(this);} observe(){} }
  // Execute the actual page script in a minimal DOM shim.
  return readFile(new URL('./sandbox.js',import.meta.url),'utf8').then(source=>{
    runInNewContext(source,{document,CustomEvent:FakeCustomEvent,MutationObserver:FakeMutationObserver,fetch:(...args)=>networkCalls.push(args),XMLHttpRequest:class{constructor(){networkCalls.push(['xhr']);}},localStorage:{setItem:(...args)=>storageCalls.push(args)},sessionStorage:{setItem:(...args)=>storageCalls.push(args)}});
    return {elements,document,networkCalls,storageCalls,setCoverage(mode){document.documentElement.dataset.shadowshieldCoverage=mode;for(const observer of observers)observer.callback([]);}};
  });
}

test('normal click and Enter send only to the in-memory receiver',async()=>{
  const {elements}=await harness(); const composer=elements['#shadow-composer'];
  composer.value='Synthetic click only: fake@example.invalid'; elements['#shadow-send'].dispatch('click');
  composer.value='Synthetic Enter only: fake-2@example.invalid'; composer.dispatch('keydown',{key:'Enter',shiftKey:false,isComposing:false});
  composer.value='Shift Enter adds a line'; composer.dispatch('keydown',{key:'Enter',shiftKey:true,isComposing:false});
  assert.deepEqual(elements['#shadow-received'].children.map(item=>item.textContent),['Synthetic click only: fake@example.invalid','Synthetic Enter only: fake-2@example.invalid']);
  assert.equal(composer.value,'Shift Enter adds a line');
});

test('typed v2 receipt fires only after accepted append and repeated attempt is ignored',async()=>{
  const {elements,document}=await harness(); const composer=elements['#shadow-composer'];
  composer.value='Approved synthetic payload';
  composer.dispatch('shadowshield:submit-request',{detail:{protocol:'v2',attemptId:'attempt-1'}});
  assert.equal(elements['#shadow-received'].children.length,1);
  assert.equal(document.dispatches[0].event.type,'shadowshield:receipt');
  assert.deepEqual(JSON.parse(JSON.stringify(document.dispatches[0].event.detail)),{protocol:'v2',attemptId:'attempt-1',status:'ACCEPTED'});
  assert.equal(document.dispatches[0].count,1);
  composer.value='Changed after accepted attempt';
  composer.dispatch('shadowshield:submit-request',{detail:{protocol:'v2',attemptId:'attempt-1'}});
  assert.equal(elements['#shadow-received'].children.length,1);
  assert.equal(document.dispatches.length,1);
  assert.equal(composer.value,'Changed after accepted attempt');
});

test('extension coverage attribute updates the guarded status handshake',async()=>{
  const {elements,setCoverage}=await harness();
  assert.equal(elements['#coverage'].textContent,'UNPROTECTED · synthetic examples only');
  setCoverage('SANDBOX_GUARDED');
  assert.equal(elements['#coverage'].textContent,'SANDBOX GUARDED · local review active');
  setCoverage('UNPROTECTED');
  assert.equal(elements['#coverage'].textContent,'UNPROTECTED · synthetic examples only');
});

test('a direct page event can forge a cooperative request and is not authorization',async()=>{
  const {elements}=await harness(); const composer=elements['#shadow-composer'];
  composer.value='Direct page event synthetic example';
  composer.dispatch('shadowshield:submit-request',{detail:{protocol:'v2',attemptId:'page-forged'}});
  assert.equal(elements['#shadow-received'].children[0].textContent,'Direct page event synthetic example');
  // This intentionally demonstrates the trust boundary: extension authorization
  // must be held outside the page; the cooperative receipt cannot provide it.
});

test('normal and cooperative sends make no network, filesystem, or browser-storage writes',async()=>{
  const {elements,networkCalls,storageCalls}=await harness();
  elements['#shadow-composer'].value='Do not persist fake@example.invalid';
  elements['#shadow-send'].dispatch('click');
  assert.deepEqual(networkCalls,[]);
  assert.deepEqual(storageCalls,[]);
  const source=await readFile(new URL('./sandbox.js',import.meta.url),'utf8');
  assert.doesNotMatch(source, /\b(fetch|XMLHttpRequest|WebSocket|sendBeacon|localStorage|sessionStorage|indexedDB|showSaveFilePicker|createWritable)\b/);
});

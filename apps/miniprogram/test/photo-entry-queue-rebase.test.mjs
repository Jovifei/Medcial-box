import assert from 'node:assert/strict';
import test from 'node:test';
import {setImmediate as tick} from 'node:timers/promises';
import {harness,edit,select,remove} from './photo-queue-test-harness.mjs';

for(const repeats of [1,2])test(`failed scalar storage preserves local edit through ${repeats} reloads with newer remote field`,async()=>{
  let fail=false;const h=harness({store:(k)=>{if(fail&&k===h.key)throw Error('synthetic storage full');}});const d=h.draft();h.seed([d]);h.attach(h.a,[d]);
  fail=true;edit(h.a,'name','Local unacknowledged name');assert.equal(h.read()[0].fields.name,'Original synthetic name');assert.equal(h.a.data.photoDrafts[0].fields.name,'Original synthetic name');
  fail=false;const b=h.page();b.loadPhotoDrafts();select(b,d.id);edit(b,'manufacturer','Remote manufacturer');
  for(let i=0;i<repeats;i++){h.a.onShow();await tick();}
  assert.equal(h.a.data.name,'Local unacknowledged name');assert.equal(h.a.data.manufacturer,'Remote manufacturer');
  edit(h.a,'specification','New specification');assert.equal(h.read()[0].fields.name,'Local unacknowledged name');assert.equal(h.read()[0].fields.manufacturer,'Remote manufacturer');
});

test('delete another draft after modal wait must not stale the active form baseline',async()=>{
  let modal;const h=harness({modal:o=>{modal=o;}});const x=h.draft('photo-100-first'),y=h.draft('photo-200-second');h.seed([x,y]);h.attach(h.a,[x,y],x.id);remove(h.a,y.id);
  const b=h.page();b.loadPhotoDrafts();select(b,x.id);edit(b,'name','Remote newer name');modal.success({confirm:true});await tick();
  assert.equal(h.read()[0].fields.name,'Remote newer name');h.a.onShow();await tick();select(h.a,x.id);
  assert.equal(h.read()[0].fields.name,'Remote newer name');
});

for(const outcome of ['success','failure'])test(`cleanup ${outcome} rebasing another target must preserve active newer fields on subsequent selection`,async()=>{
  let release;const h=harness({unlink:(o,done)=>{release=outcome==='success'?done:()=>o.fail({errMsg:'synthetic failure'});}});
  const x=h.draft('photo-100-first'),y=h.draft('photo-200-second','cleanup_pending');h.seed([x,y]);h.attach(h.a,[x,y],x.id);const running=h.a.cleanupPhotoDrafts();await tick();
  const latest=h.read();latest[0].fields.name='Remote newer name';h.storage.set(h.key,latest);release();await running;
  assert.equal(h.read()[0].fields.name,'Remote newer name');h.a.onShow();await tick();select(h.a,x.id);
  assert.equal(h.read()[0].fields.name,'Remote newer name');
});

test('failed local batch field storage does not erase a remote change to another batch field on reload',async()=>{
  let fail=false;const h=harness({store:(k)=>{if(fail&&k===h.key)throw Error('synthetic storage full');}});const d=h.draft();h.seed([d]);h.attach(h.a,[d]);
  fail=true;h.a.onBatchFieldInput({currentTarget:{dataset:{index:'0',field:'lotNumber'}},detail:{value:'LOCAL-LOT'}});fail=false;
  const b=h.page();b.loadPhotoDrafts();select(b,d.id);b.onBatchFieldInput({currentTarget:{dataset:{index:'0',field:'storageLocation'}},detail:{value:'REMOTE-SHELF'}});
  h.a.onShow();await tick();assert.equal(h.a.data.batches[0].lotNumber,'LOCAL-LOT');assert.equal(h.a.data.batches[0].storageLocation,'REMOTE-SHELF');
});

test('active field input preserves late capture added by a previously hidden page',async()=>{
  let read;const h=harness({read:o=>{read=()=>o.success({data:'/9j/2Q=='});}});const x=h.draft();h.seed([x]);const old=h.page();const capture=old.onRecognizePhoto('camera');await tick();old.onHide();
  h.a.loadPhotoDrafts();select(h.a,x.id);read();await capture;const created=h.read().find(d=>d.id!==x.id);assert.ok(created);
  edit(h.a,'manufacturer','Current page new manufacturer');assert.ok(h.files.has(created.photos[0].path));assert.ok(h.read().some(d=>d.id===created.id),'next ordinary input must retain newly acknowledged ownership receipt');
});

test('conflicting batch structures fail closed without discarding the current local form',async()=>{
  let fail=false;const h=harness({store:k=>{if(fail&&k===h.key)throw Error('synthetic storage full');}});
  const d=h.draft();h.seed([d]);h.attach(h.a,[d]);h.a.loadPhotoDrafts();
  fail=true;h.a.onBatchFieldInput({currentTarget:{dataset:{index:'0',field:'lotNumber'}},detail:{value:'LOCAL-LOT'}});fail=false;
  const newer=h.read();newer[0].fields.batches.push({...newer[0].fields.batches[0],lotNumber:'REMOTE-SECOND'});h.storage.set(h.key,newer);
  select(h.a,d.id);
  assert.equal(h.a.data.batches.length,1);assert.equal(h.a.data.batches[0].lotNumber,'LOCAL-LOT');
  assert.equal(h.read()[0].fields.batches.length,2);assert.equal(h.read()[0].fields.batches[1].lotNumber,'REMOTE-SECOND');
});

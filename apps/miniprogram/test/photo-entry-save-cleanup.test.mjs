import assert from 'node:assert/strict';
import test from 'node:test';
import {setImmediate as tick} from 'node:timers/promises';
import {harness,edit,select,remove} from './photo-queue-test-harness.mjs';

for(const outcome of ['success','failure'])test(`cleanup of another draft during ${outcome} upload retains local association and receipt progress`,async()=>{
  let unlink,upload;const h=harness({unlink:(o,done)=>{if(o.filePath.includes('photo-200-second'))unlink=done;else done();},upload:result=>new Promise((resolve,reject)=>{upload=()=>outcome==='success'?resolve(result):reject(Error('synthetic upload failure'));})});
  const x=h.draft(),y=h.draft('photo-200-second','cleanup_pending');h.seed([x,y]);h.attach(h.a,[x,y],x.id);h.a.loadPhotoDrafts();await tick();
  h.a.data.usePhotoAsCover=true;const saving=h.a.onSubmit();await tick();assert.equal(h.calls.create,1);assert.equal(h.calls.upload,1);
  unlink();await tick();upload();await saving;
  if(outcome==='success'){assert.equal(h.calls.cover,1,'completed upload must still be selected as requested cover');assert.equal(h.read().length,0);}else{assert.equal(h.read()[0].medicineId,'synthetic-created','created medicine association must survive unrelated cleanup');assert.equal(h.read()[0].status,'photo_pending');}
});

test('stored deletion intent cannot be undone by an old page field edit during its delayed writer',async()=>{
  let write;const h=harness({write:(_o,done)=>{write=done;}});const pending=h.a.onRecognizePhoto('camera');await tick();h.a.onHide();
  const b=h.page();b.loadPhotoDrafts();remove(b,b.data.photoDrafts[0].id);await tick();assert.equal(h.read()[0].status,'cleanup_pending');h.a.onShow();edit(h.a,'manufacturer','Late local edit');
  assert.equal(h.read()[0].status,'cleanup_pending');write();await pending;assert.equal(h.read()[0].status,'cleanup_pending');assert.equal(h.calls.recognize,0);
});

test('photo ownership objects in ack baseline do not alias visible queue or storage',async()=>{
  const h=harness();await h.a.onRecognizePhoto('camera');const d=h.a.data.photoDrafts[0],baseline=h.a.photoQueueBaseline[0],stored=h.read()[0];
  assert.notEqual(d,baseline);assert.notEqual(d.photos,baseline.photos);assert.notEqual(d.photos[0].ownedLocal,baseline.photos[0].ownedLocal);
  d.photos[0].uploadedId='local-upload-only';assert.equal(baseline.photos[0].uploadedId,undefined);assert.equal(h.read()[0].photos[0].uploadedId,undefined);assert.equal(stored.photos[0].uploadedId,undefined);
});

test('replacing an unsaved null-id batch at the same length must not reassign an unacknowledged field to another batch',async()=>{
  let fail=false;const h=harness({store:k=>{if(fail&&k===h.key)throw Error('synthetic storage full');}});const d=h.draft();
  d.fields.batches[0].lotNumber='FIRST';d.fields.batches[0].quantity='1';d.fields.batches.push({...d.fields.batches[0],lotNumber:'SECOND',quantity:'7'});
  h.seed([d]);h.attach(h.a,[d]);h.a.loadPhotoDrafts();fail=true;
  h.a.onBatchFieldInput({currentTarget:{dataset:{index:'0',field:'quantity'}},detail:{value:'2'}});fail=false;
  const b=h.page();b.loadPhotoDrafts();select(b,d.id);b.onRemoveBatch({currentTarget:{dataset:{index:'0'}}});b.onAddBatch();
  b.onBatchFieldInput({currentTarget:{dataset:{index:'1',field:'lotNumber'}},detail:{value:'THIRD'}});
  assert.equal(h.read()[0].fields.batches[0].lotNumber,'SECOND');assert.equal(h.read()[0].fields.batches[0].quantity,'7');
  h.a.onShow();await tick();edit(h.a,'manufacturer','Fresh manufacturer');
  const saved=h.read()[0].fields.batches;
  assert.equal(saved.find(b=>b.lotNumber==='SECOND')?.quantity,'7','quantity edited for deleted FIRST batch must never move onto SECOND');
});

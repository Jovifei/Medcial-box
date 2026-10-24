import assert from 'node:assert/strict';
import test from 'node:test';
import {loadService,makeSessionScopeModule} from '../apps/miniprogram/test/runtime.mjs';

test('concurrent strict session checks share owned invalidation without stranding the newest page',async()=>{
  let generation=1,calls=0,release;
  const gate=new Promise(resolve=>{release=resolve;});
  const identity=()=>({token:'same-user',generation});
  const current=id=>id.token==='same-user'&&id.generation===generation;
  class ApiError extends Error {
    constructor(code,message,statusCode,invalidatedSession){super(message);Object.assign(this,{code,statusCode,invalidatedSession});}
  }
  const scope=makeSessionScopeModule({userId:'u',familyId:'old'});
  const auth=loadService('services/auth.ts',{modules:{
    './api':{
      captureSessionIdentity:identity,isCurrentSession:current,ApiError,
      api:{getAuthMe:async()=>{calls++;await gate;return{user:{id:'u'},family:{id:'new'}};}},
      beginSessionTransition:()=>{generation++;return identity();},
      staleSessionError:()=>new ApiError('STALE_SESSION','stale',0),
    },
    './session-scope':scope,
  }});
  const options={allowInteractive:false,rejectScopeChange:true};
  const pending=Promise.allSettled([auth.ensureLoggedIn(options),auth.ensureLoggedIn(options)]);
  release();
  const outcomes=await pending;
  assert.equal(calls,1,'overlapping read-only validation must use one transport');
  for(const outcome of outcomes){
    assert.equal(outcome.status,'rejected');
    assert.equal(outcome.reason.code,'SESSION_SCOPE_CHANGED');
    assert.equal(current(outcome.reason.invalidatedSession),true);
  }
  assert.equal(await auth.ensureLoggedIn(options),'same-user','failed shared check must be released for the next refresh');
  assert.equal(calls,2);
});

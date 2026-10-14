import {createRequire} from 'node:module';import {writeFileSync} from 'node:fs';
const {Pool}=createRequire('/app/package.json')('pg');const original=Pool.prototype.end;let calls=0;
Pool.prototype.end=function(...args){writeFileSync('/audit/pool-end.json',JSON.stringify({poolEndCalls:++calls}));return original.apply(this,args)};
await new Pool().end();writeFileSync('/audit/control.json',JSON.stringify({instrumentationControlCalls:calls}));calls=0;writeFileSync('/audit/pool-end.json',JSON.stringify({poolEndCalls:0}));

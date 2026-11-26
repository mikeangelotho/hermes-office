import test from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createOfficeMiddleware } from './office-api.ts';
import type { HistoryQuery, ReadHistory } from './history.ts';
import { TRACE_WINDOW_MS } from '../src/domain/trace.ts';

const now = Date.UTC(2026,10,4,10), host='127.0.0.1:4010';
const live=()=>({schemaVersion:1,mode:'live',source:'Local Hermes status bridge',observedAt:new Date(now).toISOString(),pollIntervalMs:30000,sourceHealth:'connected',warnings:[],agents:[]});
function dispatch(mw:ReturnType<typeof createOfficeMiddleware>, url:string, options:{peer?:string|null;origin?:string;site?:string;method?:string}={}) {
  const headers:Record<string,string>={};
  return new Promise<{status:number;headers:Record<string,string>;body:any}>(done=>{
    const req={url,method:options.method??'GET',headers:{host,origin:options.origin,'sec-fetch-site':options.site},socket:{remoteAddress:options.peer===null?undefined:options.peer??'127.0.0.1'}} as IncomingMessage;
    const res={statusCode:200,setHeader(key:string,v:string){headers[key.toLowerCase()]=v;},end(s:string){done({status:this.statusCode,headers,body:JSON.parse(s)});}};
    mw(req,res as unknown as ServerResponse,()=>done({status:404,headers,body:null}));
  });
}

test('both private routes check the actual peer and exact origin before either collector or archive access (in-memory requests)',async()=>{
  let reads=0,calls=0;
  const mw=createOfficeMiddleware({collect:async()=>{calls++;return live();},readHistory:()=>{reads++;throw Error('unavailable');}});
  for(const path of ['/api/office','/api/office/history']) {
    for(const opt of [{peer:null},{peer:'192.0.2.15'},{origin:'http://localhost:4010'},{origin:'http://127.0.0.1:4011'},{site:'same-site'}]) {
      assert.equal((await dispatch(mw,path,opt)).status,403, path+' '+JSON.stringify(opt));
    }
  }
  assert.deepEqual([calls,reads],[0,0]);
  for(const peer of ['127.0.0.1','::1','::ffff:127.0.0.1']) {
    assert.equal((await dispatch(mw,'/api/office',{peer,origin:`http://${host}`,site:'same-origin'})).status,200);
  }
});

test('bounded read-only history inputs, no-store/CORP, and independent live/history failure domains',async()=>{
  const queries: HistoryQuery[]=[];
  const frame={atMs:now-10,coverage:'verified' as const,actors:[]};
  let liveFails=true,historyFails=false,liveCalls=0,clock=now;
  const readHistory:ReadHistory=(q,time)=>{queries.push(q);if(historyFails)throw Error('PRIVATE_STORAGE_ERROR');
    return {version:1,startMs:time-TRACE_WINDOW_MS,endMs:time,cadenceMs:15_000,firstMs:frame.atMs,lastMs:frame.atMs,frames:[frame]};};
  const mw=createOfficeMiddleware({now:()=>clock,collect:async()=>{liveCalls++;if(liveFails)throw Error('PRIVATE_COLLECTOR_ERROR');return live();},readHistory});
  const path='/api/office/history';
  for(const suffix of ['?end=-1','?end=1.5','?after=NaN','?end=9007199254740993','?end=1&after=1','?end=12&end=12','?other=1','?end=']) {
    assert.equal((await dispatch(mw,path+suffix)).status,400,suffix);
  }
  assert.equal((await dispatch(mw,path,{method:'POST'})).status,405);assert.equal(queries.length,0);
  const snapshot=await dispatch(mw,'/api/office');assert.equal(snapshot.status,503);
  for(const suffix of ['',`?end=${now}`,`?after=${now-50}`]) {
    const response=await dispatch(mw,path+suffix);assert.equal(response.status,200);assert.deepEqual(response.body.frames,[frame]);
    assert.equal(response.headers['cache-control'],'no-store');assert.equal(response.headers['cross-origin-resource-policy'],'same-origin');
    assert.equal(response.headers['access-control-allow-origin'],undefined);
  }
  assert.deepEqual(queries,[{},{end:now},{after:now-50}]);assert.equal(liveCalls,1,'history does not invoke a collector');
  historyFails=true;liveFails=false;clock+=5001;
  const failed=await dispatch(mw,path);assert.equal(failed.status,503);assert.doesNotMatch(JSON.stringify(failed.body),/PRIVATE_/);
  assert.equal((await dispatch(mw,'/api/office')).status,200);
  historyFails=false;assert.equal((await dispatch(mw,path)).status,200);
  const disabled=createOfficeMiddleware({collect:async()=>live()});assert.equal((await dispatch(disabled,path)).status,503);
});

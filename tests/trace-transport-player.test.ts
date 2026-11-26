import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test, { type TestContext } from 'node:test';
import { setImmediate as settled } from 'node:timers/promises';
import { parseTraceWindow, TRACE_CADENCE_MS, TRACE_HOLD_MS, TRACE_WINDOW_MS, type TraceFrame, type TraceWindow } from '../src/domain/trace.ts';

// Use Solid's real client effects even under the ordinary `node --test` command.
const hooks = registerHooks({ resolve(id, ctx, next) {
  return next(id, id === 'solid-js' ? { ...ctx, conditions: [...ctx.conditions, 'browser'] } : ctx);
} });
const { createRoot, createSignal } = await import('solid-js');
const { createTracePlayer } = await import('../src/lib/trace-player.ts');
hooks.deregister();

const base = 1_800_000_000_000;
const frame = (atMs:number):TraceFrame => ({ atMs, coverage:'verified', actors:[] });
function hour(endMs:number, frames:TraceFrame[]):TraceWindow {
  return { version:1, startMs:endMs-TRACE_WINDOW_MS, endMs, cadenceMs:TRACE_CADENCE_MS,
    firstMs:frames[0]?.atMs ?? null, lastMs:frames.at(-1)?.atMs ?? null, frames };
}

// All requests stop here; no recorder, server, real intervals or private data.
function client(t:TestContext, open=false) {
  let now=base, query=new URLSearchParams(), send!:(r:Response)=>void;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', (path:string, init:RequestInit) => {
    const url=new URL(path,'http://fixture.invalid');
    assert.equal(url.pathname,'/api/office/history'); query=url.searchParams;
    return new Promise<Response>((resolve,reject) => {
      send=resolve; init.signal?.addEventListener('abort', () => reject(new Error('cancelled')), {once:true});
    });
  });
  const doc=Object.assign(new EventTarget(), {hidden:false});
  Object.assign(globalThis, {document:doc, window:{setInterval:()=>1, clearInterval(){}}});
  const [opened, edit]=createSignal(open);
  const p=createRoot(dispose => { t.after(dispose); return createTracePlayer(()=>true,opened); });
  t.after(() => { Reflect.deleteProperty(globalThis,'document'); Reflect.deleteProperty(globalThis,'window'); });
  return {p, edit, query:()=>query, advance:(ms:number)=>{now+=ms;},
    visible(on:boolean){ doc.hidden=!on; doc.dispatchEvent(new Event('visibilitychange')); },
    async reply(value:TraceWindow|null){ send(value ? Response.json(value) : new Response(null,{status:503})); await settled(); }};
}

for (const cause of ['pin during full request','reject older full'] as const) {
  test(`a tail cannot inherit export eligibility: ${cause}`, async t => {
    const h=client(t), {p}=h, records=[frame(base-120_000),frame(base-1000)];
    const tail={...hour(base,records),frames:records.slice(-1)};
    await h.reply(tail); h.edit(true); assert.equal(h.query().size,0);
    if(cause==='pin during full request') p.seek(tail.startMs);
    await h.reply(hour(base+(cause==='pin during full request'?1000:-100),records));
    assert.deepEqual(p.window(),tail); assert.equal(p.completeHour(),false);

    p.goLive();
    if(cause==='reject older full') assert.equal(h.query().size,0,'retry the rejected full');
    const full=hour(base+2000,records); await h.reply(full);
    assert.equal(p.completeHour(),true); assert.deepEqual(parseTraceWindow(p.window()),full);
    const saved=hour(base-2*TRACE_WINDOW_MS,[frame(base-2*TRACE_WINDOW_MS-1000)]);
    void p.openArchive(saved.endMs); assert.equal(h.query().get('end'),String(saved.endMs)); await h.reply(saved);
    assert.equal(p.completeHour(),true); assert.deepEqual(parseTraceWindow(p.window()),saved);
  });
}

test('an empty full hour keeps its acquisition cursor through a read outage', async t => {
  const h=client(t,true), {p}=h;
  await h.reply(hour(base,[])); assert.equal(p.completeHour(),true);
  h.advance(TRACE_CADENCE_MS); void p.refresh(); await h.reply(null);
  h.advance(5*TRACE_CADENCE_MS); void p.refresh();
  assert.equal(h.query().get('after'),String(base),'do not skip observations recorded during the outage');
  const records=[frame(base+TRACE_CADENCE_MS),frame(base+6*TRACE_CADENCE_MS)];
  await h.reply(hour(records[1].atMs,records)); p.seek(records[0].atMs);
  assert.equal(p.frame()?.atMs,records[0].atMs); assert.equal(p.completeHour(),true);
});

test('resuming a closed editor requests only a recent tail; opening still requests the full hour', async t => {
  const h=client(t), end=base+2*TRACE_WINDOW_MS;
  await h.reply(hour(base,[frame(base)])); h.visible(false); h.advance(end-base); h.visible(true);
  const after=h.query().get('after'); assert.ok(after && Number(after)>=end-TRACE_HOLD_MS && Number(after)<=end);
  await h.reply(hour(end,[frame(end)])); assert.equal(h.p.completeHour(),false);
  h.edit(true); assert.equal(h.query().size,0);
  const full=hour(end,[frame(end-120_000),frame(end)]); await h.reply(full);
  assert.equal(h.p.completeHour(),true); assert.deepEqual(h.p.window(),full);
});

for(const initial of ['nonempty','empty']) {
  test(`a delta from a replaced ${initial} archive cannot certify its missing prefix`, async t => {
    const h=client(t,true), {p}=h, before=initial==='nonempty'?[frame(base-150_000),frame(base-5000)]:[];
    await h.reply(hour(base,before));void p.refresh();
    assert.ok(h.query().has('after'));
    const records=[frame(base-90_000),frame(base-6000),frame(base+1000)], full=hour(base+1000,records);
    // An earlier capture exists on disk, but only the predecessor and new suffix were returned.
    await h.reply({...full,frames:records.slice(1)});
    assert.equal(p.completeHour(),false);assert.deepEqual(p.window()?.frames,records.slice(1));
    void p.refresh();assert.equal(h.query().size,0);await h.reply(full);
    assert.equal(p.completeHour(),true);assert.deepEqual(p.window(),full);
  });
}

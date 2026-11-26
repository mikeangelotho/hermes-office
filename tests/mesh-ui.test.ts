import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
const file=new URL('../scripts/mesh-ui.mjs',import.meta.url);

test('Mesh serves an in-memory production UI, not a directory or a development server',async()=>{
  assert.ok(existsSync(file),'No in-memory Mesh UI builder');
  assert.match(readFileSync(file,'utf8'),/\benvDir\s*:\s*false\b/,'Mesh UI build must disable Vite .env file loading');
  const {buildMeshAssets}=await import(file.href);
  const assets=await buildMeshAssets() as Map<string,{body:Buffer,type:string}>;
  const html=assets.get('/')?.body.toString(); assert.ok(html?.includes('Office Hours'));
  const refs=Array.from(html!.matchAll(/(?:src|href)="(\/[^\"]+)"/g),x=>x[1]); assert.ok(refs.length>=3);
  for(const ref of refs) assert.ok(assets.has(ref),ref);
  assert.match(assets.get('/favicon.svg')?.type??'',/image\/svg/);
  assert.equal([...assets.keys()].some(name=>name.includes('three')&&name.endsWith('.js')),true);
  for(const [name,v] of assets){assert.match(name,/^(?:\/|\/favicon\.svg|\/assets\/[\w-]+\.(?:js|css))$/);assert.ok(Buffer.isBuffer(v.body)&&v.body.length>0);}
  assert.equal(assets.has('/package.json'),false);assert.equal(assets.has('/api/office'),false);
});

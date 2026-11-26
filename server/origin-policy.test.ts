import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfigFromFile } from 'vite';
import * as api from './office-api.ts';

test('Office private reads allow the exact browser origin or a direct local health check only', () => {
  const policy=(api as unknown as { permitsOfficeRead?: (host:string|undefined, origin:string|undefined, site:string|string[]|undefined, secure:boolean)=>boolean }).permitsOfficeRead;
  assert.equal(typeof policy,'function','loopback is not interchangeable with the Office browser origin');
  const accepts=policy!;
  assert.equal(accepts('127.0.0.1:3002','http://127.0.0.1:3002','same-origin',false),true);
  assert.equal(accepts('127.0.0.1:3002',undefined,undefined,false),true);
  assert.equal(accepts('[::1]:3002','https://[::1]:3002','same-origin',true),true);
  assert.equal(accepts('localhost:80','http://localhost','same-origin',false),true);
  assert.equal(accepts('127.0.0.1:3002','http://127.0.0.1:3010',undefined,false),false);
  assert.equal(accepts('127.0.0.1:3002','http://localhost:3002',undefined,false),false);
  assert.equal(accepts('127.0.0.1:3002','https://127.0.0.1:3002',undefined,false),false);
  assert.equal(accepts('localhost:3002',undefined,'same-site',false),false);
  assert.equal(accepts('localhost:3002',undefined,'cross-site',false),false);
  assert.equal(accepts(undefined,undefined,undefined,false),false);
  assert.equal(accepts('127.0.0.1:99999',undefined,undefined,false),false);
});

test('neither Office web server opts the private site into cross-origin reads', async()=>{
  const result = await loadConfigFromFile({command:'serve',mode:'production'},undefined,process.cwd(),'silent');
  assert.equal(result?.config.server?.cors,false,'disable the default development CORS policy');
  assert.equal(result?.config.preview?.cors,false,'disable the default preview CORS policy');
});

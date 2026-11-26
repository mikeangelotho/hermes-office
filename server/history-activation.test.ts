import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { build, createServer, isFileLoadingAllowed, normalizePath, preview, type InlineConfig, type PreviewServer } from 'vite';
import { officeApiPlugin } from './office-api.ts';
import { desktopHistory } from './history-desktop.ts';

test('normal build, dev/HMR and plain preview never create a writer, even with an explicit QA directory',async t=>{
  const dir=mkdtempSync(join(process.env.TMPDIR||tmpdir(),'office-no-writer-')), root=join(dir,'web'),history=join(dir,'tape');
  mkdirSync(root);writeFileSync(join(root,'index.html'),'<title>Private boundary fixture</title>');
  const privateEnv={OFFICE_HISTORY_DIR:history,HERMES_HOME:join(dir,'synthetic-home'),PYTHON_BIN:join(dir,'absent-python'),LOCALAPPDATA:join(dir,'appdata'),XDG_DATA_HOME:join(dir,'appdata')};
  const before=Object.fromEntries(Object.keys(privateEnv).map(k=>[k,process.env[k]]));Object.assign(process.env,privateEnv);
  t.after(()=>{for(const [k,v] of Object.entries(before)){if(v===undefined)delete process.env[k];else process.env[k]=v;}rmSync(dir,{recursive:true,force:true,maxRetries:3});});
  const config:InlineConfig={root,configFile:false,plugins:[officeApiPlugin()],logLevel:'silent',
    server:{host:'127.0.0.1',middlewareMode:true,watch:null,hmr:false,ws:false},optimizeDeps:{noDiscovery:true}};
  await build(config);assert.ok(!existsSync(history));
  const dev=await createServer(config);
  try {assert.ok(!existsSync(history));assert.equal(isFileLoadingAllowed(dev.config,normalizePath(join(history,'recordings.sqlite3'))),false);}
  finally {await dev.close();}
  const server=await preview({...config,preview:{host:'127.0.0.1',port:0,strictPort:true,open:false}});
  try {
    const b=server.httpServer.address();assert.ok(b && typeof b!=='string' && b.port!==3002);
    const result=await fetch(`http://127.0.0.1:${b.port}/api/office/history`);assert.equal(result.status,503);assert.ok(!existsSync(history));
    // Admission is tested in memory: do not create a wildcard listener.
    const mock={httpServer:{address:()=>({address:'0.0.0.0',port:b.port})},config:server.config} as unknown as PreviewServer;
    assert.equal(await desktopHistory(b.port).start(mock),false);assert.ok(!existsSync(history));
    // A configured open static filesystem is not a private place to enable recording.
    const listener=Object.assign(new EventEmitter(),{listening:true,address:()=>b});
    const loose={httpServer:listener,config:{...server.config,preview:{...server.config.preview,port:b.port},
      server:{...server.config.server,fs:{...server.config.server.fs,strict:false}}}} as unknown as PreviewServer;
    const enabled=await desktopHistory(b.port).start(loose);listener.emit('close');
    assert.equal(enabled,false,'require a bounded Vite filesystem');assert.ok(!existsSync(history));
  } finally {await server.close();}
});

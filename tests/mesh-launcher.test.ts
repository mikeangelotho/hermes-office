import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync,readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cli = new URL('../scripts/mesh.mjs',import.meta.url);
test('Mesh launcher accepts no host, port or forwarding override from the command line',()=>{
  assert.ok(existsSync(cli),'No opt-in Mesh launcher');
  const run=spawnSync(process.execPath,[fileURLToPath(cli),'--host','0.0.0.0'],{encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(run.status,1);assert.match(run.stderr,/no arguments|Usage:/i);
});
test('Windows Mesh shortcut opens just the optional reader, never a second recorder',()=>{
  const cmd=new URL('../Start Office Mesh.cmd',import.meta.url);assert.ok(existsSync(cmd),'No optional Windows Mesh shortcut');
  const text=readFileSync(cmd,'utf8');assert.match(text,/scripts[\\/]mesh\.mjs/i);assert.doesNotMatch(text,/desktop\.mjs|--host|0\.0\.0\.0|netsh|firewall/i);
});

// Opt-in companion to the already running desktop recorder. No TLS proxy, DNS or firewall setup.
import { Agent, request } from 'node:http';
import { meshAddress } from '../server/mesh-address.ts';

const port=3002;
const direct=new Agent({keepAlive:false});
function hasSignature(host, header, expected) {
  return new Promise(resolve=>{
    const req=request({host,port,path:'/',method:'HEAD',family:4,agent:direct,headers:{Accept:'text/html'},signal:AbortSignal.timeout(3500)},res=>{
      res.resume();resolve(res.statusCode===200 && res.headers[header]===expected);
    });
    req.on('error',()=>resolve(false));req.end();
  });
}

async function main() {
  if (process.argv.length!==2) throw new Error('Usage: node scripts/mesh.mjs (no arguments)');
  const host=meshAddress();
  if (!host) throw new Error('No unique CloudflareWARP IPv4 device address in the configured Mesh pool. Nothing was opened.');
  if (!await hasSignature('127.0.0.1','x-hermes-office-desktop','office-hours-desktop-v1'))
    throw new Error('Start the desktop Office first (Start Office.cmd). The Mesh viewer does not start or replace the recorder.');
  const url=`http://${host}:${port}/?view=ambient`;
  const {buildMeshAssets}=await import('./mesh-ui.mjs');
  const {createMeshViewer}=await import('../server/mesh-viewer.ts');
  const assets=await buildMeshAssets();
  const interfacePresent=()=>meshAddress()===host;
  if (!interfacePresent()) throw new Error('Mesh interface changed during startup; nothing was opened.');
  const server=createMeshViewer({host,assets,interfacePresent});
  try {
    await new Promise((resolve,reject)=>{
      server.once('error',reject);server.listen({host,port,exclusive:true},()=>{server.off('error',reject);resolve();});
    });
  } catch (error) {
    if (error.code!=='EADDRINUSE') throw new Error('Cannot bind to the Mesh interface. No process was stopped.');
    if (!await hasSignature(host,'x-hermes-office-mesh','office-mesh-v1')) throw new Error('Mesh port 3002 is in use by another service. No process was stopped.');
    console.log(`Office Mesh is already running: ${url}`);return;
  }
  const bound=server.address();
  if (!bound || typeof bound==='string' || bound.family!=='IPv4' || bound.address!==host || bound.port!==port || !interfacePresent()) {
    server.close();throw new Error('Stopped an unexpected Mesh binding.');
  }
  function stop() {server.close();server.closeAllConnections();direct.destroy();}
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  console.log(`Office Mesh: ${url}\nRead-only. Ctrl+C here stops Mesh viewing; the desktop recorder stays running.`);
}
main().catch(e=>{console.error(`Office Mesh: ${e.message}`);process.exitCode=1;});

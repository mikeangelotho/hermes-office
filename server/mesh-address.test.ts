import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import type { NetworkInterfaceInfo } from 'node:os';
const file=new URL('./mesh-address.ts',import.meta.url);
const iface=(address:string,internal=false)=>({address,family:'IPv4',internal} as NetworkInterfaceInfo);

test('select only the unique CloudflareWARP device IPv4, never a Wi-Fi or wildcard fallback',async()=>{
  assert.ok(existsSync(file),'Mesh adapter selection does not exist yet');
  const {meshAddress,isMeshIPv4}=await import(file.href);
  const warp='100.96.0.1', other='100.101.20.4';
  assert.equal(meshAddress({WiFi:[iface('10.0.0.6')], CloudflareWARP:[iface(warp)]}),warp);
  assert.equal(meshAddress({CloudflareWARP:[iface(other)]}),other);
  for(const table of [{},{WiFi:[iface(warp)]},{CloudflareWARP:[iface('0.0.0.0')]},{CloudflareWARP:[iface('10.0.0.1')]},
    {CloudflareWARP:[iface(warp,true)]},{CloudflareWARP:[iface(warp),iface(other)]},
    {CloudflareWARP:[iface(warp)],WiFi:[iface(warp)]}]) assert.equal(meshAddress(table),null);
  for(const address of [warp,other,'100.111.255.254']) assert.equal(isMeshIPv4(address),true);
  for(const address of [null,'','0.0.0.0','100.96.0.0','100.95.255.255','100.111.255.255','100.112.0.1','10.96.0.1','::ffff:100.96.0.3','100.96.0.03','100.96.0.256'])assert.equal(isMeshIPv4(address),false);
});

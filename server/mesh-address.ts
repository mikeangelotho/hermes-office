import { BlockList, isIPv4 } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

// This installation's assigned Cloudflare device pool, not the entire CGNAT address space.
const devices = new BlockList();
devices.addSubnet('100.96.0.0', 12, 'ipv4');
export function isMeshIPv4(value: unknown): value is string {
  return typeof value === 'string' && isIPv4(value) && value !== '100.96.0.0' && value !== '100.111.255.255' && devices.check(value, 'ipv4');
}

/** An address from a Wi-Fi adapter with similar numbering is not a Mesh interface. */
export function meshAddress(interfaces: Record<string, NetworkInterfaceInfo[] | undefined> = networkInterfaces()): string | null {
  const name = 'CloudflareWARP';
  const addresses = interfaces[name]?.filter(a => !a.internal && a.family === 'IPv4' && isMeshIPv4(a.address));
  if (addresses?.length !== 1) return null;
  const { address } = addresses[0];
  return Object.entries(interfaces).some(([key, others]) => key !== name && others?.some(a => a.address === address)) ? null : address;
}

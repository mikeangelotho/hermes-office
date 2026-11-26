import { readFile, lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const types = { html:'text/html; charset=utf-8', js:'text/javascript; charset=utf-8', css:'text/css; charset=utf-8', svg:'image/svg+xml' };

/** Serve the exact production output in memory; never resolve an HTTP path on disk. */
export async function buildMeshAssets() {
  const result = await build({ root, configFile:join(root,'vite.config.ts'), envDir:false, publicDir:false, logLevel:'error',
    build:{write:false,emptyOutDir:false,sourcemap:false,reportCompressedSize:false} });
  const assets = new Map();
  for (const bundle of Array.isArray(result) ? result : [result]) {
    for (const item of bundle.output) {
      const name = item.fileName;
      const ext = name==='index.html' ? 'html' : /^assets\/[\w-]+\.(js|css)$/.exec(name)?.[1];
      if (!ext || (ext==='js') !== (item.type==='chunk')) throw new Error('Unexpected Mesh UI build output');
      const key = ext==='html' ? '/' : '/'+name;
      if (assets.has(key)) throw new Error('Duplicate Mesh UI asset');
      assets.set(key,{body:Buffer.from(item.type==='chunk'?item.code:item.source),type:types[ext]});
    }
  }
  if (!assets.has('/') || ![...assets.keys()].some(key=>key.endsWith('.js'))) throw new Error('Incomplete Mesh UI build');
  // This is the sole reviewed public asset; do not copy anything else from public/.
  const icon=join(root,'public','favicon.svg'),stat=await lstat(icon);
  if (!stat.isFile() || stat.size>32768 || await realpath(icon)!==join(await realpath(root),'public','favicon.svg')) throw new Error('Unexpected Office icon');
  assets.set('/favicon.svg',{body:await readFile(icon),type:types.svg});
  return assets;
}

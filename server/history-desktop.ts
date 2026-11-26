import { resolve } from 'node:path';
import type { Plugin, PreviewServer } from 'vite';
import { createBridgeCollector, createHistoryMiddleware } from './office-api.ts';
import type { HistoryArchive } from './history.ts';

/** A capability installed by the desktop launcher only, after its build. It has no dev or build hook. */
export function desktopHistory(port: number) {
  let archive:HistoryArchive|undefined;
  const plugin:Plugin = {name:'office-desktop-recording', enforce:'pre', configurePreviewServer(server) {
    server.middlewares.use(createHistoryMiddleware((query, now)=>{
      if (!archive) throw new Error('Recorder unavailable');
      return archive.read(query,now);
    }));
  }};
  async function start(server:PreviewServer) {
    const bound=server.httpServer.address(), config=server.config;
    if (!bound || typeof bound==='string' || bound.address!=='127.0.0.1' || bound.port!==port ||
      config.preview.host!=='127.0.0.1' || config.preview.port!==port || !config.preview.strictPort || !config.server.fs.strict) return false;
    if (archive) return true;
    if (port!==3002 && !process.env.OFFICE_HISTORY_DIR) return false;
    try {
      // Importing the ordinary plugin, reloading Vite's config, or building a bundle cannot touch SQLite.
      const {openHistory,desktopDirectory}=await import('./history.ts');
      const {createRecorder}=await import('./recording.ts');
      const dir=desktopDirectory(port,process.env);
      if (!dir || !server.httpServer.listening) return false;
      const roots=[config.root,config.publicDir,resolve(config.root,config.build.outDir),...config.server.fs.allow].filter(Boolean);
      archive=openHistory(dir,roots);
      const recorder=createRecorder({archive,collect:createBridgeCollector(config.root,true)});
      server.httpServer.once('close',()=>{recorder.stop();archive?.close();archive=undefined;});
      recorder.start();return true;
    } catch {
      // No paths, collector output or database details in either the public console or response.
      console.warn('Office recording unavailable; live status is independent.');return false;
    }
  }
  return {plugin,start};
}

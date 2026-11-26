import { execFile } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

interface Discovery {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  probe?: (file: string) => Promise<boolean>;
}

const isFile = (file: string) => { try { return statSync(file).isFile(); } catch { return false; } };
const isAlias = (file: string) => /(?:^|[\\/])Microsoft[\\/]WindowsApps(?:[\\/]|$)/i.test(file);
const check = 'import sys,sqlite3; from pathlib import Path; assert sys.version_info >= (3,12) and hasattr(Path,"is_junction"); print("office-python-ready")';
const probePython = (file: string) => new Promise<boolean>(done => {
  execFile(file, ['-I', '-B', '-c', check], {timeout:1800, maxBuffer:4096, windowsHide:true, encoding:'utf8'},
    (error, stdout) => done(!error && stdout.trim() === 'office-python-ready'));
});

/** Used only by the local Node bridge. Never install Python or invoke Windows' Store aliases. */
export async function resolveOfficePython({env=process.env, platform=process.platform, probe=probePython}: Discovery = {}): Promise<string> {
  const win = platform === 'win32';
  const paths = (env.PATH ?? env.Path ?? '').split(win ? ';' : ':').map(p => p.replace(/^"(.*)"$/, '$1')).filter(p => p && isAbsolute(p));
  const pathCandidates = (command: string) => paths.map(p => join(p, win && !/\.exe$/i.test(command) ? `${command}.exe` : command));
  const candidates: string[] = [];
  if (env.PYTHON_BIN) {
    const bin=env.PYTHON_BIN;
    candidates.push(...(isAbsolute(bin) || /[\\/]/.test(bin) ? [resolve(bin)] : pathCandidates(bin)));
  } else {
    const defaultHome=win ? join(env.LOCALAPPDATA || join(homedir(),'AppData','Local'), 'hermes') : join(homedir(),'.hermes');
    const configured=env.HERMES_HOME ? resolve(env.HERMES_HOME) : defaultHome;
    for (const root of new Set([basename(dirname(configured)).toLowerCase()==='profiles' ? dirname(dirname(configured)) : configured, defaultHome])) {
      const python = win ? ['Scripts','python.exe'] : ['bin','python'];
      candidates.push(join(root,'hermes-agent','venv',...python), join(root,'venv',...python));
      if (win) {
        const tools=join(root,'tools');
        try {
          const bundles=readdirSync(tools,{withFileTypes:true}).filter(e=>e.isDirectory() && /^python-\d+\.\d+\.\d+[^\\/]*-win32-(?:x64|arm64|ia32)$/i.test(e.name));
          bundles.sort((a,b)=>b.name.localeCompare(a.name,'en',{numeric:true}));
          candidates.push(...bundles.map(b=>join(tools,b.name,'python.exe')));
        } catch {} // Not every installation has a bundled toolchain.
      }
    }
    for (const name of win ? ['python','python3'] : ['python3','python']) candidates.push(...pathCandidates(name));
  }
  for (const file of new Set(candidates)) {
    if ((!win || !isAlias(file)) && isFile(file) && await probe(file)) return file;
  }
  throw new Error(env.PYTHON_BIN ? 'PYTHON_BIN is not a working Python 3.12+ interpreter with SQLite.' : 'No usable Python 3.12+ with SQLite. Set PYTHON_BIN to its executable and relaunch Office.');
}

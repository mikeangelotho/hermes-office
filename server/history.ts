import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { homedir } from 'node:os';
import { closeSync, lstatSync, mkdirSync, openSync, realpathSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseTraceWindow, TRACE_CADENCE_MS, TRACE_HOLD_MS, TRACE_WINDOW_MS, type TraceFrame, type TraceWindow } from '../src/domain/trace.ts';

export interface HistoryQuery {end?: number; after?: number}
export type ReadHistory = (query: HistoryQuery, nowMs: number) => TraceWindow;
export type HistoryArchive = ReturnType<typeof openHistory>;
const filename = 'recordings.sqlite3';
const sqliteFiles = ['', '-journal', '-shm', '-wal'].map(suffix => filename+suffix);
const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT';

// Resolve through existing junctions, even when the requested leaf does not exist yet.
function physical(path: string): string {
  try { return realpathSync.native(path); } catch (e) {
    const parent = dirname(path);
    if (!missing(e) || parent === path) throw e;
    return join(physical(parent), relative(parent, path));
  }
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..'+sep);
}
/** An alternate listener must supply a distinct, absolute QA destination. */
export function desktopDirectory(port: number, env: NodeJS.ProcessEnv): string|null {
  const home=homedir();
  const data=process.platform==='win32' ? env.LOCALAPPDATA || join(home,'AppData','Local')
    : process.platform==='darwin' ? join(home,'Library','Application Support') : env.XDG_DATA_HOME || join(home,'.local','share');
  const normal=join(data,'Hermes Office'), override=env.OFFICE_HISTORY_DIR;
  if (override===undefined) return port===3002 ? normal : null;
  if (!isAbsolute(override) || /^[/\\]{2}/.test(override)) throw new Error('Invalid recording directory');
  if (port!==3002 && inside(physical(resolve(normal)),physical(resolve(override)))) return null;
  return override;
}

// Stock Windows PowerShell's .NET Framework overload passes this DACL to CreateDirectoryW
// at creation. It does not change the ACL of an existing directory. No script file or profile.
function prepareWindowsArchive(dir: string) {
  const command = `$ErrorActionPreference = 'Stop'
    [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $dir = $request.dir
    $token = [Security.Principal.WindowsIdentity]::GetCurrent()
    $user = $token.User.Value
    $owners = @($user, 'S-1-5-18', 'S-1-5-32-544')
    if ($owners -notcontains $token.Owner.Value) { throw 'default file owner' }
    $allowed = $owners + @('S-1-3-4', 'S-1-3-0') # OWNER RIGHTS and CREATOR OWNER
    function Assert-Private($security, $directory) {
      $sd = [Security.AccessControl.RawSecurityDescriptor]::new($security.GetSecurityDescriptorBinaryForm(), 0)
      if ($owners -notcontains $sd.Owner.Value -or $null -eq $sd.DiscretionaryAcl) { throw 'owner or DACL' }
      $inheritsToFiles = $false
      foreach ($ace in $sd.DiscretionaryAcl) {
        if ($ace.AceType -eq 'AccessDenied') { continue }
        if ($ace.AceType -ne 'AccessAllowed' -or $allowed -notcontains $ace.SecurityIdentifier.Value) { throw 'grant' }
        if ([int]$ace.AceFlags -band [int][Security.AccessControl.AceFlags]::ObjectInherit) { $inheritsToFiles = $true }
      }
      # Without file inheritance, future SQLite journals could get the token's default DACL instead.
      if ($directory -and -not $inheritsToFiles) { throw 'file inheritance' }
    }
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetSecurityDescriptorSddlForm('O:' + $user + 'D:P(A;OICI;FA;;;' + $user + ')(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')
    $folder = [IO.Directory]::CreateDirectory($dir, $acl)
    Assert-Private ($folder.GetAccessControl()) $true
    $db = [IO.Path]::Combine($dir, $request.names[0])
    $create = $false
    foreach ($name in $request.names) {
      $path = [IO.Path]::Combine($dir, $name)
      try { $security = [IO.File]::GetAccessControl($path) } catch [IO.FileNotFoundException] {
        if ($path -eq $db) { $create = $true }
        continue
      }
      Assert-Private $security $false
    }
    if ($create) {
      [IO.File]::Open($db, 'CreateNew', 'Write', 'None').Dispose()
      Assert-Private ([IO.File]::GetAccessControl($db)) $false
    }
    'private'`;
  const exe = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result = spawnSync(exe, ['-NoLogo','-NoProfile','-NonInteractive','-Command',command],
    {input:JSON.stringify({dir, names:sqliteFiles}), encoding:'utf8', shell:false, windowsHide:true, timeout:8000, maxBuffer:4096, stdio:['pipe','pipe','ignore']});
  if (result.status !== 0 || result.stdout.trim() !== 'private') throw new Error('Recording archive is not private');
}

function archiveFile(dir: string, staticRoots: string[]): string {
  if (!isAbsolute(dir) || /^[/\\]{2}/.test(dir) || !staticRoots.length) throw new Error('Invalid recording directory');
  const requested = resolve(dir), target = physical(requested);
  for (const root of staticRoots) {
    const served = resolve(root), actual = physical(served);
    if (sqliteFiles.some(name => inside(served,join(requested,name)) || inside(actual,join(target,name)))) throw new Error('Recordings must be outside served directories');
  }
  const windows = process.platform === 'win32', uid = process.getuid?.();
  const privateOwner = (st: Stats) => st.uid === uid && (st.mode & 0o077) === 0;
  if (!windows) {
    mkdirSync(target, {recursive: true, mode: 0o700});
    if (!privateOwner(lstatSync(target))) throw new Error('Recording directory is not private');
  }
  const file = join(target, filename);
  for (const name of sqliteFiles) {
    let st;
    try { st = lstatSync(join(target,name)); } catch (e) { if (missing(e)) continue; throw e; }
    if (!st.isFile() || st.nlink !== 1 || (!windows && !privateOwner(st))) throw new Error('Invalid recording file');
  }
  if (windows) prepareWindowsArchive(target);
  else try { closeSync(openSync(file, 'wx', 0o600)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  return file;
}

const bounds = (endMs: number) => ({version: 1 as const, startMs: Math.max(0, endMs-TRACE_WINDOW_MS), endMs, cadenceMs: TRACE_CADENCE_MS});

/** One desktop owns this database. SQLite releases the exclusive lock even on an unclean process exit. */
export function openHistory(dir: string, staticRoots: string[]) {
  const db = new DatabaseSync(archiveFile(dir, staticRoots));
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE');
    const version = db.prepare('PRAGMA user_version').get()?.user_version;
    if (version === 0 && !db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get()) {
      db.exec(`CREATE TABLE identity (id INTEGER PRIMARY KEY CHECK(id=1), salt BLOB NOT NULL CHECK(length(salt)=32)) STRICT;
        INSERT INTO identity VALUES (1, randomblob(32));
        CREATE TABLE states (at_ms INTEGER PRIMARY KEY, coverage TEXT NOT NULL, actors TEXT NOT NULL) STRICT;
        CREATE TABLE samples (at_ms INTEGER PRIMARY KEY, state_ms INTEGER NOT NULL REFERENCES states(at_ms)) STRICT;
        PRAGMA user_version=1`);
    } else if (version !== 1) throw new Error('Unsupported recording archive');
    db.exec('COMMIT');
    const salt = db.prepare('SELECT salt FROM identity WHERE id=1').get()?.salt;
    if (!(salt instanceof Uint8Array) || salt.length !== 32) throw new Error('Invalid recording identity');
    const profileId = (id: string) => 'r-'+createHmac('sha256',salt).update(id).digest('hex').slice(0,32);
    const select = 'SELECT s.at_ms, s.state_ms, v.coverage, v.actors FROM samples s JOIN states v ON s.state_ms=v.at_ms';
    const prior = db.prepare(`${select} WHERE s.at_ms BETWEEN ? AND ? ORDER BY s.at_ms DESC LIMIT 1`);
    const range = db.prepare(`${select} WHERE s.at_ms > ? AND s.at_ms <= ? ORDER BY s.at_ms LIMIT 513`);
    const extrema = db.prepare('SELECT (SELECT min(at_ms) FROM samples) AS firstMs, (SELECT max(at_ms) FROM samples) AS lastMs');
    const addState = db.prepare('INSERT INTO states(at_ms, coverage, actors) VALUES (?, ?, ?)');
    const addSample = db.prepare('INSERT INTO samples(at_ms, state_ms) VALUES (?, ?)');
    let head = db.prepare(`${select} ORDER BY s.at_ms DESC LIMIT 1`).get();
    const read: ReadHistory = ({end, after}, nowMs) => {
      const w = bounds(Math.min(end ?? nowMs, nowMs)), lower = Math.max(w.startMs, Math.min(after ?? w.startMs, w.endMs));
      const previous = prior.get(lower-TRACE_HOLD_MS, lower), rows = range.all(lower, w.endMs);
      if (previous) rows.unshift(previous);
      if (rows.length > 512) throw new Error('Recording window exceeds the sample limit');
      const frames = rows.map(r => ({atMs: r.at_ms, coverage: r.coverage, actors: JSON.parse(String(r.actors))}));
      return parseTraceWindow({...w, ...extrema.get(), frames});
    };
    function append(frame: TraceFrame): boolean {
      // A caller's type is not a privacy boundary. Reconstruct a strict wire frame before any SQL bind.
      const [safe] = parseTraceWindow({...bounds(frame.atMs), firstMs:frame.atMs, lastMs:frame.atMs, frames:[frame]}).frames;
      if (head && safe.atMs <= Number(head.at_ms)) return false;
      const actors = JSON.stringify(safe.actors), changed = actors !== head?.actors || safe.coverage !== head?.coverage;
      const stateMs = changed ? safe.atMs : Number(head!.state_ms);
      db.exec('BEGIN');
      try {
        if (changed) addState.run(safe.atMs, safe.coverage, actors);
        addSample.run(safe.atMs, stateMs);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      head = {at_ms: safe.atMs, state_ms: stateMs, coverage:safe.coverage, actors};
      return true;
    }
    return {append, read, profileId, close: () => db.close()};
  } catch (e) { db.close(); throw e; }
}

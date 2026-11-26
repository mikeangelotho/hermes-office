import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { desktopDirectory, openHistory } from './history.ts';

const windowsOnly = {skip: process.platform !== 'win32'};
const at = Date.UTC(2026, 10, 4, 9);
const frame = {atMs: at, coverage: 'verified' as const, actors: []};

// Exercise the logged-in Windows token. Paths are literal data, never PowerShell source.
function fixtureCommand(command: string, paths: string[]) {
  const ps = join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const prefix = `$ErrorActionPreference = 'Stop'
    [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
    $paths = ([Console]::In.ReadToEnd() | ConvertFrom-Json).paths
    $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  `;
  const r = spawnSync(ps, ['-NoLogo','-NoProfile','-NonInteractive','-Command',prefix + command],
    {input:JSON.stringify({paths}), encoding:'utf8', timeout:8000, maxBuffer:4096, windowsHide:true});
  assert.equal(r.status, 0, 'Windows ACL fixture command failed');
  return r.stdout.trim();
}

function sharedParent(t: TestContext) {
  const root = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'office-acl-'));
  t.after(() => rmSync(root, {recursive:true, force:true, maxRetries:3}));
  // Put exactly one ordinary read/execute grant on this disposable subtree, never on its host parent.
  const shared = join(root, "shared [fixture] & 'α'");
  fixtureCommand(`$acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetSecurityDescriptorSddlForm('D:P(A;OICI;FA;;;' + $me + ')(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)(A;OICI;GRGX;;;BU)')
    [void][IO.Directory]::CreateDirectory($paths[0], $acl)`, [shared]);
  const parent = join(shared, 'synthetic-local-data');
  mkdirSync(parent, {mode:0o700}); // Ordinary Node creation inherits the reader, despite the mode.
  return parent;
}

// An independent observer: count actual, non-inherit-only read grants, without printing account identifiers.
function aclReports(paths: string[]): {currentOwner:boolean; trustedOwner:boolean; protected:boolean; readers:number; inheritedReaders:number; fingerprint:string}[] {
  return JSON.parse(fixtureCommand(`$trusted = @($me, 'S-1-5-18', 'S-1-5-32-544', 'S-1-3-4')
    $rows = @(foreach ($path in $paths) {
      $acl = Get-Acl -LiteralPath $path
      $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object {
        $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band 1) -and
        -not ($_.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -and
        $trusted -notcontains $_.IdentityReference.Value
      })
      $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
      [pscustomobject]@{currentOwner=($owner -eq $me); trustedOwner=($owner -in @($me, 'S-1-5-18', 'S-1-5-32-544'));
        protected=$acl.AreAccessRulesProtected;
        fingerprint=[Convert]::ToBase64String([Security.Cryptography.SHA256]::Create().ComputeHash($acl.GetSecurityDescriptorBinaryForm()));
        readers=$rules.Count; inheritedReaders=@($rules | Where-Object IsInherited).Count}
    }); ConvertTo-Json -InputObject $rows -Compress`, paths));
}

test('Windows desktop archive and SQLite file exclude a reader inherited by their scratch parent, including on restart', windowsOnly, t => {
  const parent = sharedParent(t), dir = desktopDirectory(3002, {LOCALAPPDATA:parent})!;
  const roots = [process.cwd()], db = join(dir,'recordings.sqlite3');
  function check(label: string, journal = false) {
    const [control, folder, file, sidecar] = aclReports([parent, dir, db, ...(journal ? [db+'-journal'] : [])]);
    t.diagnostic(`${label} extra read ACEs: scratch parent=${control.readers}, archive=${folder.readers}, database=${file.readers}` + (sidecar ? `, journal=${sidecar.readers}` : ''));
    assert.equal(control.inheritedReaders, 1, 'the Node-created control must inherit the fixture reader');
    assert.deepEqual([folder.readers, file.readers], [0,0]);
    assert.ok(folder.currentOwner && folder.protected && file.trustedOwner);
    if (journal) assert.ok(sidecar.trustedOwner && sidecar.readers === 0, 'the real SQLite rollback journal must also be private');
  }
  const first = openHistory(dir, roots);
  try { assert.equal(first.append(frame), true); check('created',true); } finally { first.close(); }
  const reopened = openHistory(dir, roots);
  try { assert.deepEqual(reopened.read({},at).frames, [frame]); } finally { reopened.close(); }
  check('reopened');
});

test('an existing shared directory is refused without creating the archive or changing its ACL', windowsOnly, t => {
  const shared = sharedParent(t), before = aclReports([shared]);
  assert.equal(before[0].inheritedReaders, 1);
  assert.throws(() => openHistory(shared,[process.cwd()]).close(), /not private/);
  assert.equal(existsSync(join(shared,'recordings.sqlite3')), false);
  assert.deepEqual(aclReports([shared]), before);
});

for (const suffix of ['', '-journal', '-wal', '-shm']) {
  test(`a readable existing ${suffix || 'database'} is refused without changing any bytes or ACLs`, windowsOnly, t => {
    const dir = join(sharedParent(t),'archive'), roots = [process.cwd()], db = join(dir,'recordings.sqlite3');
    const seed = openHistory(dir,roots);
    try { seed.append(frame); } finally { seed.close(); }
    const target = db + suffix;
    if (suffix) writeFileSync(target, 'retained synthetic sidecar');
    const grant = spawnSync(join(process.env.SystemRoot!,'System32/icacls.exe'), [target,'/grant','*S-1-5-32-545:R'],
      {timeout:8000, maxBuffer:4096, windowsHide:true, stdio:'ignore'});
    assert.equal(grant.status, 0, 'grant a reader only on this synthetic input file');
    const [before] = aclReports([target]); assert.equal(before.readers, 1);
    const databaseBytes = readFileSync(db), targetBytes = readFileSync(target);
    assert.throws(() => openHistory(dir,roots).close(), /not private/);
    assert.deepEqual(readFileSync(db),databaseBytes); assert.deepEqual(readFileSync(target),targetBytes);
    assert.deepEqual(aclReports([target]), [before]);
  });
}

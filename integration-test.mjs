// Uses the real native compiler and compatible mapper, but only a disposable
// fixture in persistent project scratch. Never opens VS Code or the user's PDF.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scratch = process.env.TYPST_SUMATRA_SCRATCH;
if (!scratch) throw Error('Set TYPST_SUMATRA_SCRATCH to persistent project scratch');
const work = fs.mkdtempSync(path.join(scratch, 'bridge-test-'));
fs.mkdirSync(path.join(work, 'scratch')); // Also discoverable from a fresh WSL recovery process.
const input = path.join(work, 'test.typ'), pdf = path.join(work, 'test.pdf');
const metadataFile = path.join(work, '.test.typst-sync.json');
fs.writeFileSync(input, 'Alpha beta gamma.\n');
const log = fs.openSync(path.join(work, 'bridge.log'), 'a');
const bridge = spawn(process.execPath, [fileURLToPath(new URL('./typst-sumatra.mjs', import.meta.url)),
  'watch', '--root', work, input, pdf], { stdio: ['ignore', log, log] });
fs.closeSync(log);
let metadata;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(url, body) {
  metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
  const response = await fetch(`http://127.0.0.1:${metadata.port}/${url}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${metadata.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(22000),
  });
  const data = await response.json();
  if (!response.ok) throw Error(JSON.stringify(data));
  return data;
}
async function waitFor(predicate, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (bridge.exitCode !== null) throw Error('Bridge exited; see ' + work);
    try { const status = await api('status'); if (predicate(status)) return status; } catch {}
    await pause(50);
  }
  throw Error('Timed out; see ' + work);
}
const firstRecord = () => Number(fs.readFileSync(path.join(work, 'test.synctex'), 'utf8').match(/\(1,(\d+):/)[1]);
try {
  let status = await waitFor(s => s.mappingReady && s.mapperReady && s.mapperPaused);
  console.log('Background warmup:', status.timings);
  assert.equal(metadata.version, 3);
  const forbidden = await fetch(`http://127.0.0.1:${metadata.port}/status`);
  assert.equal(forbidden.status, 403);
  let id = firstRecord();
  const first = await api('resolve', { id });
  assert.equal(first.filepath, input);
  assert.equal(first.line, 1);
  await waitFor(s => s.mapperPaused);
  assert.deepEqual(await api('resolve', { id }), first);
  status = await api('status');
  assert.equal(status.mapperPaused, true, 'A cache hit must not wake the mapper');
  assert.equal(status.timings.lastResolveCacheHit, true);
  const oldRevision = status.revision, oldPid = status.mapperPid;
  fs.writeFileSync(input, '\n\nAlpha beta gamma.\n');
  status = await waitFor(s => s.revision > oldRevision && s.mappingReady && s.mapperReady && s.mapperPaused);
  assert.notEqual(status.mapperPid, oldPid, 'New PDF must not query the previous compiled snapshot');
  assert.equal(status.cachedPositions, 0);
  id = firstRecord();
  const changed = await api('resolve', { id });
  assert.equal(changed.filepath, input);
  assert.equal(changed.line, 3, 'Cached positions must be invalidated after edits');
  const revision = status.revision;
  fs.writeFileSync(input, 'Intermediate text.\n');
  await pause(60);
  fs.writeFileSync(input, '\n\n\nFinal text.\n');
  await waitFor(s => s.revision > revision && s.mappingReady && s.mapperReady && s.mapperPaused);
  const final = await api('resolve', { id: firstRecord() });
  assert.equal(final.line, 4);
  console.log('PASS: authentication, eager warmup, cached fast path, edit invalidation and rapid edits.');
  console.log('Persistent fixture:', work);
} finally {
  try { await api('shutdown', {}); } catch { bridge.kill(); }
  for (let i = 0; i < 60 && bridge.exitCode === null; i++) await pause(50);
  if (bridge.exitCode === null) bridge.kill('SIGKILL');
}

// Optional end-to-end cold recovery through the installed native Windows client.
// Its only editor-facing action is --resolve-only; it never opens a window.
if (process.env.TYPST_SUMATRA_CLIENT) {
  const oldPid = metadata.pid;
  const windowsMetadata = `\\\\wsl.localhost\\${process.env.WSL_DISTRO_NAME || 'Ubuntu'}${metadataFile.replaceAll('/', '\\')}`;
  try {
    const output = await new Promise((resolve, reject) => {
      const client = spawn(process.env.TYPST_SUMATRA_CLIENT,
        [windowsMetadata, String(firstRecord()), '1', '--resolve-only'],
        { cwd: '/mnt/c/Windows', stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      const timer = setTimeout(() => { client.kill(); reject(Error('Cold recovery timed out')); }, 30000);
      client.stdout.on('data', data => { out += data; });
      client.stderr.on('data', data => { err += data; });
      client.on('error', error => { clearTimeout(timer); reject(error); });
      client.on('exit', code => {
        clearTimeout(timer);
        code === 0 ? resolve(out) : reject(Error(err || `Native client exited ${code}`));
      });
    });
    const position = JSON.parse(output);
    assert.equal(position.filepath, input);
    assert.equal(position.line, 4);
    metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
    assert.notEqual(metadata.pid, oldPid);
    console.log('PASS: native client recovered a stopped bridge through wsl.exe.');
  } finally {
    metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
    if (metadata.pid !== oldPid) await api('shutdown', {});
  }
}

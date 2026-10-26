// Uses the real native compiler and compatible mapper, but only a disposable
// fixture in persistent project scratch. Never opens VS Code or the user's PDF.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scratch = process.env.TYPST_SUMATRA_SCRATCH;
if (!scratch) throw Error('Set TYPST_SUMATRA_SCRATCH to persistent project scratch');
const work = fs.mkdtempSync(path.join(scratch, 'bridge-test-'));
fs.mkdirSync(path.join(work, 'scratch')); // Also discoverable from a fresh WSL recovery process.
const input = path.join(work, 'test.typ'), pdf = path.join(work, 'test.pdf');
const metadataFile = path.join(work, '.test.typst-sync.json');
fs.writeFileSync(input, 'Alpha beta gamma.\n');
const ipcScratch = fileURLToPath(new URL('./scratch/', import.meta.url));
fs.mkdirSync(ipcScratch, { recursive: true });
const editorSocket = path.join(ipcScratch, `integration-${process.pid}.sock`);
const editorRequests = [];
const editor = http.createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  editorRequests.push(JSON.parse(body));
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end('null');
});
await new Promise((resolve, reject) => { editor.once('error', reject); editor.listen(editorSocket, resolve); });
const log = fs.openSync(path.join(work, 'bridge.log'), 'a');
const bridge = spawn(process.execPath, [fileURLToPath(new URL('./typst-sumatra.mjs', import.meta.url)),
  'watch', '--root', work, input, pdf], { stdio: ['ignore', log, log],
  env: { ...process.env, VSCODE_IPC_HOOK_CLI: editorSocket } });
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
  assert.equal(metadata.version, 4);
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
  // Record 1 is page 1's empty top-left margin: five negative source replies,
  // then nearby real text. The old log matcher timed out on the first reply.
  const blank = await api('resolve', { id: 1 });
  assert.equal(blank.filepath, input);
  assert.equal(blank.line, 1);
  assert.equal(blank.approximate, true);
  assert.equal((await api('status')).mapperPid, status.mapperPid,
    'A negative source reply must not discard the warmed mapper');
  console.log('Empty-margin fallback (ms):', (await api('status')).timings.lastResolveMs);
  assert.equal(editorRequests.length, 0, 'Resolve-only requests must not open the editor');
  const unauthorised = await fetch(`http://127.0.0.1:${metadata.port}/resolve`, {
    method: 'POST', body: JSON.stringify({ id, open: true }),
  });
  assert.equal(unauthorised.status, 403);
  assert.equal(editorRequests.length, 0);
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await api('resolve', { id, open: true }), { ...first, opened: true });
    assert.equal(editorRequests.length, i + 1, 'Each cached click must still open its location');
    assert.equal(editorRequests[i].fileURIs[0], pathToFileURL(`${input}:${first.line}:${first.column}`).href);
    assert.equal(editorRequests[i].gotoLineMode, true);
    assert.equal(editorRequests[i].forceReuseWindow, true);
  }
  if (process.env.TYPST_SUMATRA_CLIENT) {
    const windowsMetadata = `\\\\wsl.localhost\\${process.env.WSL_DISTRO_NAME || 'Ubuntu'}${metadataFile.replaceAll('/', '\\')}`;
    const result = await new Promise((resolve, reject) => {
      const client = spawn(process.env.TYPST_SUMATRA_CLIENT, [windowsMetadata, String(id), '1'], {
        cwd: '/mnt/c/Windows', stdio: ['ignore', 'pipe', 'pipe'],
        // Fail closed if IPC regresses; a test must never fall back to the real GUI.
        env: { ...process.env, TYPST_SUMATRA_CODE_ROOT: 'C:\\typst-sumatra-no-real-editor',
          WSLENV: (process.env.WSLENV || '') + ':TYPST_SUMATRA_CODE_ROOT' },
      });
      let errors = '';
      client.stderr.on('data', data => { errors += data; });
      client.once('error', reject);
      client.once('exit', code => resolve({ code, errors }));
    });
    assert.equal(result.code, 0, result.errors);
    assert.equal(editorRequests.length, 3);
    assert.equal((await api('status')).editor.lastRequest.transport, 'vscode-ipc');
    console.log('PASS: native Windows client → real bridge → mock editor IPC, without Code.exe.');
  }
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
  await new Promise(resolve => editor.close(resolve));
  assert.equal((await api('resolve', { id: firstRecord(), open: true })).opened, false);
  assert.equal((await api('status')).editor.lastRequest.transport, 'cli-fallback');
  console.log('PASS: authentication, eager warmup, cached fast path, edit invalidation, rapid edits and IPC fallback.');
  console.log('Persistent fixture:', work);
} finally {
  if (editor.listening) await new Promise(resolve => editor.close(resolve));
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

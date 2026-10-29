// Real compilers, isolated persistent scratch; never opens a viewer or editor.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sourceHash } from './forward.mjs';

const scratch = process.env.TYPST_SUMATRA_SCRATCH;
if (!scratch) throw Error('Set TYPST_SUMATRA_SCRATCH to persistent project scratch');
const work = fs.mkdtempSync(path.join(scratch, 'syntax-error-test-'));
const input = path.join(work, 'test.typ'), pdf = path.join(work, 'test.pdf');
const metadataFile = path.join(work, '.test.typst-sync.json');
const script = fileURLToPath(new URL('./typst-sumatra.mjs', import.meta.url));
// Diagnostics quote this line; its text must not be mistaken for compiler status.
const invalid = 'Alpha beta gamma.\n#let broken = ( // compiled successfully; compiling ...\n';
fs.writeFileSync(input, invalid);
const args = ['--root', work, input, pdf];
const log = fs.openSync(path.join(work, 'bridge.log'), 'a');
const bridge = spawn(process.execPath, [script, 'watch', ...args], { stdio: ['ignore', log, log] });
fs.closeSync(log);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(route, body, timeout = 23000) {
  const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
  const response = await fetch(`http://127.0.0.1:${metadata.port}/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${metadata.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout),
  });
  return { status: response.status, body: await response.json() };
}
async function waitFor(predicate) {
  for (let i = 0; i < 400; i++) {
    if (bridge.exitCode !== null) throw Error('Bridge exited; see ' + work);
    try { const { body } = await api('status'); if (predicate(body)) return body; } catch {}
    await pause(50);
  }
  throw Error('Timed out; see ' + work);
}
const payload = text => ({ filepath: input, line: 1, column: 7, sourceHash: sourceHash(text) });
const record = () => Number(fs.readFileSync(path.join(work, 'test.synctex'), 'utf8').match(/\(1,(\d+):/)[1]);
const failures = [];
async function failedJump(route, body) {
  const started = Date.now();
  const response = await api(route, body, 3000);
  const ms = Date.now() - started;
  assert.equal(response.status, 500);
  assert.match(response.body.error, /Typst compilation failed; fix the errors/);
  assert.ok(ms < 1500, `${route} took ${ms} ms instead of failing promptly`);
  failures.push({ route, ms });
}
try {
  let status = await waitFor(s => s.compileState === 'error');
  assert.equal(status.ready, false);
  assert.equal(status.mappingReady, false);
  assert.equal(status.mapperRunning, false);
  await failedJump('resolve', { id: 1 });
  await failedJump('forward', payload(invalid));
  // Opening a project with no successful PDF must not wait 40 seconds in ensure.
  const started = Date.now();
  const ensured = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, 'ensure', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    const timer = setTimeout(() => { child.kill(); reject(Error('ensure did not fail promptly')); }, 3000);
    child.stderr.on('data', chunk => { error += chunk; });
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.once('exit', code => { clearTimeout(timer); resolve({ code, error }); });
  });
  assert.equal(ensured.code, 1);
  assert.match(ensured.error, /Typst compilation failed/);
  assert.ok(Date.now() - started < 1500);

  fs.writeFileSync(input, 'Alpha beta gamma.\n');
  status = await waitFor(s => s.compileState === 'success' && s.mappingReady && s.mapperReady && s.mapperPaused);
  assert.equal(status.compileError, null);
  assert.equal((await api('resolve', { id: record() })).body.line, 1);
  assert.equal((await api('forward', payload('Alpha beta gamma.\n'))).status, 200);
  const goodPdf = fs.readFileSync(pdf), goodMap = fs.readFileSync(pdf.replace(/\.pdf$/, '.synctex'));
  const revision = status.revision;
  fs.writeFileSync(input, invalid);
  // Arrive while the save/failure may still be pending, not only after it settles.
  await Promise.all([
    failedJump('forward', payload(invalid)),
    waitFor(s => s.revision > revision && s.compileState === 'error'),
  ]);
  await Promise.all(Array.from({ length: 4 }, () => Promise.all([
    failedJump('resolve', { id: record(), open: true }), failedJump('forward', payload(invalid)),
  ])));
  status = (await api('status')).body;
  assert.equal(status.ready, true, 'The last good PDF remains available');
  assert.equal(status.mappingReady, false);
  assert.equal(status.mapperRunning, false, 'Failed clicks must not keep starting compilers');
  assert.equal(status.cachedPositions, 0);
  assert.equal(status.editor.lastRequest, null, 'Errors must not navigate to a stale source position');
  assert.deepEqual(fs.readFileSync(pdf), goodPdf);
  assert.deepEqual(fs.readFileSync(pdf.replace(/\.pdf$/, '.synctex')), goodMap);
  await pause(1000);
  assert.equal((await api('status')).body.mapperRunning, false);

  fs.writeFileSync(input, '\n\nAlpha beta gamma.\n');
  await waitFor(s => s.revision > status.revision && s.compileState === 'success' && s.mappingReady && s.mapperReady);
  const inverse = await api('resolve', { id: record() });
  assert.equal(inverse.body.line, 3, 'Repair must use new source coordinates');
  const forward = await api('forward', { ...payload('\n\nAlpha beta gamma.\n'), line: 3 });
  assert.equal(forward.status, 200);
  assert.equal(forward.body.page, 1);
  fs.writeFileSync(path.join(work, 'result.json'), JSON.stringify({ failures, recovered: true }, null, 2));
  console.log('PASS: cold errors, ensure, pending/burst jumps, no mapper retries, preserved PDF and automatic recovery.');
  console.log('Failed jump latencies (ms):', failures.map(f => f.ms).join(', '));
  console.log('Persistent fixture:', work);
} finally {
  try { await api('shutdown', {}); } catch { bridge.kill(); }
  for (let i = 0; i < 60 && bridge.exitCode === null; i++) await pause(50);
  if (bridge.exitCode === null) bridge.kill('SIGKILL');
}

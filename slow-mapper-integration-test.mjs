// Real bridge/native Typst + a controlled 22.5-second mapper. No GUI opens.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scratch = process.env.TYPST_SUMATRA_SCRATCH;
if (!scratch) throw Error('Set TYPST_SUMATRA_SCRATCH to persistent project scratch');
const work = fs.mkdtempSync(path.join(scratch, 'slow-mapper-test-'));
const home = path.join(work, 'home');
fs.mkdirSync(path.join(home, '.cargo/bin'), { recursive: true });
fs.mkdirSync(path.join(home, '.local/lib/typst-sumatra/bin'), { recursive: true });
fs.symlinkSync(path.join(os.homedir(), '.cargo/bin/typst'), path.join(home, '.cargo/bin/typst'));
const fake = path.join(home, '.local/lib/typst-sumatra/bin/tinymist-0.14.20');
const fakeSource = path.join(work, 'slow-mapper.mjs');
fs.copyFileSync(path.join(here, 'test-fixtures/slow-mapper.mjs'), fakeSource);
fs.chmodSync(fakeSource, 0o755);
fs.symlinkSync(fakeSource, fake);
const input = path.join(work, 'main.typ'), pdf = path.join(work, 'main.pdf');
const starts = path.join(work, 'starts.log');
fs.writeFileSync(input, 'Alpha beta gamma.\n');
const log = fs.openSync(path.join(work, 'bridge.log'), 'a');
const bridge = spawn(process.execPath, [path.join(here, 'typst-sumatra.mjs'), 'watch', '--root', work, input, pdf],
  { stdio: ['ignore', log, log], env: { ...process.env, HOME: home, SLOW_MAPPER_STARTS: starts } });
fs.closeSync(log);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(route, body, signal = AbortSignal.timeout(25000)) {
  const meta = JSON.parse(fs.readFileSync(path.join(work, '.main.typst-sync.json'), 'utf8'));
  const response = await fetch(`http://127.0.0.1:${meta.port}/${route}`, {
    method: body === undefined ? 'GET' : 'POST', signal,
    headers: { Authorization: `Bearer ${meta.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
async function waitFor(predicate) {
  for (let i = 0; i < 600; i++) {
    if (bridge.exitCode !== null) throw Error('Bridge exited; see ' + work);
    try { const s = (await api('status')).body; if (predicate(s)) return s; } catch {}
    await pause(50);
  }
  throw Error('Timed out; see ' + work);
}
try {
  const initial = await waitFor(s => s.mappingReady && s.mapperRunning);
  const id = Number(fs.readFileSync(path.join(work, 'main.synctex'), 'utf8').match(/\(1,(\d+):/)[1]);
  await assert.rejects(api('resolve', { id }, AbortSignal.timeout(100)), /aborted|timeout/i);
  await pause(1100); // An abandoned request's old idle timer would SIGSTOP warmup.
  const afterCancel = (await api('status')).body;
  assert.equal(afterCancel.mapperPid, initial.mapperPid);
  assert.equal(afterCancel.mapperPaused, false);

  const started = Date.now();
  const waiting = await api('resolve', { id });
  const elapsed = Date.now() - started;
  assert.equal(waiting.status, 500);
  assert.match(waiting.body.error, /^Source mapper is still preparing this PDF in the background/);
  assert.doesNotMatch(waiting.body.error, /compilation failed|PreviewCliArgs/);
  assert.ok(elapsed < 22000, 'Interactive request must not wait for the 90-second startup budget');
  const afterTimeout = (await api('status')).body;
  assert.equal(afterTimeout.mapperPid, initial.mapperPid);
  assert.equal(afterTimeout.mapperPaused, false);
  assert.equal(afterTimeout.mapperReady, false);
  assert.equal(afterTimeout.compileState, 'success');

  const recovered = await api('resolve', { id });
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.filepath, input);
  assert.equal(recovered.body.line, 1);
  const final = await waitFor(s => s.mapperReady && s.mapperPaused);
  assert.equal(final.mapperPid, initial.mapperPid);
  assert.equal(fs.readFileSync(starts, 'utf8').trim().split('\n').length, 1,
    'Cancellation, timeout and the next click must share one slow compiler');
  console.log('PASS: slow warmup survives cancellation and interactive timeout, completes and pauses normally.');
  console.log('Interactive timeout (ms):', elapsed);
  console.log('Persistent fixture:', work);
} finally {
  try { await api('shutdown', {}); } catch { bridge.kill(); }
  for (let i = 0; i < 60 && bridge.exitCode === null; i++) await pause(50);
  if (bridge.exitCode === null) bridge.kill('SIGKILL');
}

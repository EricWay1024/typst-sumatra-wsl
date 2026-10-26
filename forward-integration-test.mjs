// Real native Typst, standalone mapper and SyncTeX parser. No viewer/editor opens.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sourceHash } from './forward.mjs';
import { sourceMap } from './typst-sumatra.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scratch = process.env.TYPST_SUMATRA_SCRATCH;
if (!scratch) throw Error('Set TYPST_SUMATRA_SCRATCH to persistent project scratch');
const work = fs.mkdtempSync(path.join(scratch, 'forward-test-'));
const main = path.join(work, 'main.typ'), chapter = path.join(work, 'α chapter.typ');
const pdf = path.join(work, 'main.pdf'), metadataFile = path.join(work, '.main.typst-sync.json');
let text = 'First page marker.\n#pagebreak()\nα 𝒜 needle target.\n';
fs.writeFileSync(main, '#set page(width: 260pt, height: 260pt, margin: 20pt)\n#include "α chapter.typ"\n');
fs.writeFileSync(chapter, text);
const log = fs.openSync(path.join(work, 'bridge.log'), 'a');
const bridge = spawn(process.execPath, [path.join(here, 'typst-sumatra.mjs'), 'watch', '--root', work, main, pdf],
  { stdio: ['ignore', log, log] });
fs.closeSync(log);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let metadata;
async function api(route, body, authenticate = true) {
  metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
  const response = await fetch(`http://127.0.0.1:${metadata.port}/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(authenticate ? { Authorization: `Bearer ${metadata.token}` } : {}), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(25000),
  });
  const data = await response.json();
  if (!response.ok) throw Error(`${response.status} ${data.error}`);
  return data;
}
async function waitFor(predicate) {
  for (let i = 0; i < 400; i++) {
    if (bridge.exitCode !== null) throw Error('Bridge exited: ' + work);
    try { const s = await api('status'); if (predicate(s)) return s; } catch {}
    await pause(50);
  }
  throw Error('Timed out: ' + work);
}
const payload = () => ({ filepath: chapter, line: text.split('\n').findIndex(l => l.includes('needle')) + 1,
  column: text.split('\n').find(l => l.includes('needle')).indexOf('needle') + 1, sourceHash: sourceHash(text) });
function record(word) {
  const pages = JSON.parse(execFileSync('python3', [path.join(here, 'extract-boxes.py'), pdf], { encoding: 'utf8' }));
  return sourceMap(pages, metadataFile, false).points.find(p => p.text === word);
}
try {
  let status = await waitFor(s => s.mappingReady && s.mapperReady && s.mapperPaused);
  await assert.rejects(api('forward', payload(), false), /403/);
  await assert.rejects(api('forward', { ...payload(), filepath: main, sourceHash: 'bad' }), /changed or is unsaved/);
  await assert.rejects(api('forward', { ...payload(), column: 10000 }), /outside the saved file/);
  const before = status.mapperPid;
  const target = await api('forward', payload());
  assert.equal(target.page, 2);
  assert.equal(target.record, record('needle').id, 'UTF-16 cursor after a supplementary character must reach the right word');
  const inverse = await api('resolve', { id: target.record });
  assert.equal(inverse.filepath, chapter);
  assert.equal(inverse.line, 3);
  await waitFor(s => s.mapperPaused);
  assert.deepEqual(await api('forward', payload()), target);
  status = await api('status');
  assert.equal(status.mapperPaused, true);
  assert.equal(status.mapperPid, before);
  assert.equal(status.timings.lastForwardCacheHit, true);
  // This is exactly the source/record pair passed to Sumatra -forward-search.
  const synctex = execFileSync('synctex', ['view', '-i', `${target.record}:0:${target.source}`, '-o', pdf], { encoding: 'utf8' });
  assert.match(synctex, /Page:2\b/);
  console.log('PASS: source → mapper → coordinate record → real SyncTeX forward lookup (page 2).');
  await Promise.all([api('forward', payload()), api('resolve', { id: 1 })]);
  const oldPayload = payload(), oldRevision = status.revision;
  text = '#pagebreak()\n' + text;
  fs.writeFileSync(chapter, text);
  await assert.rejects(api('forward', oldPayload), /changed or is unsaved/);
  // Deliberately submit before waiting for compilation: this must wait for the save.
  const changed = await api('forward', payload());
  assert.equal(changed.page, 3);
  assert.ok(changed.revision > oldRevision);
  assert.notEqual(changed.record, target.record);
  assert.equal(changed.record, record('needle').id);
  const unused = path.join(work, 'unused.typ');
  fs.writeFileSync(unused, 'Not included.\n');
  // Make its timestamp older than PDF publication: it isn't a pending source save.
  fs.utimesSync(unused, new Date(0), new Date(0));
  await assert.rejects(api('forward', { filepath: unused, line: 1, column: 1,
    sourceHash: sourceHash('Not included.\n') }), /No PDF position received/);
  assert.equal((await api('status')).mapperRunning, false, 'Discard a timed-out untagged connection');
  const recovery = await api('forward', { ...payload(), column: payload().column + 'needle '.length });
  assert.equal(recovery.record, record('target.').id);
  console.log('PASS: Unicode, imported source, cached lookup, concurrent directions, saves, invalidation and timeout recovery.');
  console.log('Persistent fixture:', work);
} finally {
  try { await api('shutdown', {}); } catch { bridge.kill(); }
  for (let i = 0; i < 60 && bridge.exitCode === null; i++) await pause(50);
  if (bridge.exitCode === null) bridge.kill('SIGKILL');
}

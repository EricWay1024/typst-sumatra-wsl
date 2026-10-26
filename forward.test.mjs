import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceHash, sourcePosition, readForwardSource, parseJumpFrame, forwardRecord, normalWord, refineForward, checkForwardRequest } from './forward.mjs';

const scratch = fileURLToPath(new URL('./scratch/', import.meta.url));
fs.mkdirSync(scratch, { recursive: true });

test('source columns convert UTF-16 to Unicode scalars, with CRLF and BOM handling', () => {
  assert.deepEqual(sourcePosition('α𝒜z\r\nnext', 1, 4), { line: 0, character: 2 });
  assert.deepEqual(sourcePosition('α𝒜z\r\nnext', 2, 2), { line: 1, character: 1 });
  assert.deepEqual(sourcePosition('\uFEFFabc', 1, 1), { line: 0, character: 1 });
  assert.throws(() => sourcePosition('α𝒜z', 1, 3), /splits/);
  for (const [line, col] of [[0, 1], [1, 0], [2, 1], [1, 20], [1.5, 1]])
    assert.throws(() => sourcePosition('abc', line, col));
  assert.equal(sourceHash('\uFEFFabc'), sourceHash('abc'));
  assert.equal(normalWord('$needle.$'), 'needle');
});

test('saved-source validation rejects stale hashes, paths outside root and escaping symlinks', t => {
  const root = fs.mkdtempSync(path.join(scratch, 'forward-unit-'));
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  const file = path.join(project, 'α space.typ'), outside = path.join(root, 'outside.typ');
  fs.writeFileSync(file, 'α 𝒜 needle.\n'); fs.writeFileSync(outside, 'outside');
  const payload = { filepath: file, line: 1, column: 6, sourceHash: sourceHash('α 𝒜 needle.\n') };
  const source = readForwardSource(project, payload);
  assert.equal(source.character, 4);
  assert.equal(source.word, 'needle');
  assert.equal(source.tokenStart, 4);
  assert.equal(source.tokenEnd, 11);
  assert.throws(() => readForwardSource(project, { ...payload, sourceHash: 'stale' }), /changed or is unsaved/);
  assert.throws(() => readForwardSource(project, { ...payload, filepath: outside }), /outside/);
  fs.symlinkSync(outside, path.join(project, 'escape.typ'));
  assert.throws(() => readForwardSource(project, { ...payload, filepath: path.join(project, 'escape.typ') }), /outside/);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
});

test('only valid bounded jump frames are decoded from the mixed SVG/data socket', () => {
  const frame = Buffer.from('jump,1 10.5 20,2 30 40');
  assert.deepEqual(parseJumpFrame(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.length)),
    [{ page: 1, x: 10.5, y: 20 }, { page: 2, x: 30, y: 40 }]);
  assert.equal(parseJumpFrame(Buffer.from('<svg>not a jump</svg>')), null);
  assert.equal(parseJumpFrame('jump,' + '1'.repeat(70000)), null);
  assert.deepEqual(parseJumpFrame('jump,'), []);
  for (const text of ['jump,0 1 2', 'jump,1 NaN 0', 'jump,1 -1 2', 'jump,1 2 3 4'])
    assert.throws(() => parseJumpFrame(text));
});

test('span fallback uses only the indicated pages and labels its approximation', () => {
  const pages = new Map([[2, [{ id: 10, box: [0, 0, 10, 10] }, { id: 20, box: [20, 0, 30, 10] }]]]);
  const result = forwardRecord([{ page: 2, x: 23, y: 5 }], pages);
  assert.equal(result.record, 20);
  assert.equal(result.accuracy, 'span');
  assert.equal(result.approximate, true);
  assert.throws(() => forwardRecord([{ page: 1, x: 23, y: 5 }], pages), /No PDF text/);
});

test('cancelled/expired forward requests are rejected before source work', () => {
  assert.throws(() => checkForwardRequest({ destroyed: true }, Infinity), /cancelled/);
  assert.throws(() => checkForwardRequest({ destroyed: false }, Date.now() - 1), /expired/);
  checkForwardRequest({ destroyed: false }, Infinity);
});

test('HTTP cancellation drains the outstanding mapper reply, skips remaining probes and unblocks the next request', async t => {
  const source = { filepath: '/project/a.typ', line: 0, word: 'needle', tokenStart: 0, tokenEnd: 6 };
  const pageLookup = new Map([[1, Array.from({ length: 32 }, (_, i) => ({ id: i + 1, text: 'needle', box: [i * 10, 0, i * 10 + 8, 8] }))]]);
  const sourceCache = new Map();
  let release, started, firstResponse, queuedResponse, queuedStarted, accepted = 0, queries = 0, queue = Promise.resolve();
  const entered = new Promise(resolve => { started = resolve; });
  const queuedEntered = new Promise(resolve => { queuedStarted = resolve; });
  const query = async () => {
    if (++queries === 1) { started(); return new Promise(resolve => { release = resolve; }); }
    assert.equal(sourceCache.size, 0, 'The cancelled reply must not populate the source cache');
    return { filepath: source.filepath, line: 1, column: 2 };
  };
  const server = http.createServer(async (request, response) => {
    request.resume(); firstResponse ||= response;
    if (++accepted === 2) { queuedResponse = response; queuedStarted(); }
    const check = () => checkForwardRequest(response, Infinity);
    const result = queue.then(async () => {
      check();
      return refineForward(source, [{ page: 1, x: 0, y: 0 }], { pageLookup, sourceCache, query, check });
    });
    queue = result.catch(() => {});
    try { const target = await result; response.end(JSON.stringify(target)); }
    catch { if (!response.destroyed) { response.statusCode = 500; response.end(); } }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/forward`, controller = new AbortController();
  const old = fetch(url, { method: 'POST', signal: controller.signal });
  const cancelled = assert.rejects(old, /abort/i);
  await entered;
  const disconnected = once(firstResponse, 'close');
  controller.abort(); await cancelled; await disconnected;
  const queuedController = new AbortController();
  const queued = fetch(url, { method: 'POST', signal: queuedController.signal });
  const queuedCancelled = assert.rejects(queued, /abort/i);
  await queuedEntered;
  const queuedDisconnected = once(queuedResponse, 'close');
  queuedController.abort(); await queuedCancelled; await queuedDisconnected;
  const next = fetch(url, { method: 'POST' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(queries, 1, 'Do not release the serial queue before draining the untagged reply');
  release(null);
  const response = await next;
  assert.equal(response.status, 200);
  assert.equal((await response.json()).record, 1);
  assert.equal(queries, 2, 'Skip cancelled queued work: only the in-flight probe and the newest request reach the mapper');
});

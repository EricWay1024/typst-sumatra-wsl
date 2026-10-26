import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceHash, sourcePosition, readForwardSource, parseJumpFrame, forwardRecord, normalWord } from './forward.mjs';

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

// Read-only CPU audit. No bridge requests, compiler, editor or viewer launches.
// Usage: node optimization-benchmark.mjs POINTS.json SOURCE.typ [SOURCE.typ ...]
// The input documents stay private: output contains sizes and timings, not text/paths.
// These prototypes are NOT wired into the production bridge.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { indexPoints } from './typst-sumatra.mjs';
import { normalWord, readForwardSource, sourceHash } from './forward.mjs';

const [pointsFile, ...files] = process.argv.slice(2);
if (!pointsFile || !files.length) throw Error('Supply points JSON and one or more Typst sources');
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
let checksum = 0;
function batch(fn, iterations) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) checksum ^= Number(fn()) || 0;
  return (performance.now() - start) / iterations;
}
function compare(first, second, iterations) {
  for (let i = 0; i < 20; i++) { first(); second(); }
  const a = [], b = [];
  for (let round = 0; round < 11; round++) {
    if (round % 2) { b.push(batch(second, iterations)); a.push(batch(first, iterations)); }
    else { a.push(batch(first, iterations)); b.push(batch(second, iterations)); }
  }
  return { baselineMs: median(a), prototypeMs: median(b), rounds: 11, iterationsPerRound: iterations };
}

// Keep the path confinement and full content-hash check. Omit only re-parsing
// the already-validated request's source position/token on every later check.
function validateOnly(root, request) {
  if (typeof request.filepath !== 'string' || !path.isAbsolute(request.filepath) || !request.filepath.endsWith('.typ'))
    throw Error('Invalid source path');
  const filepath = fs.realpathSync(request.filepath);
  const relative = path.relative(fs.realpathSync(root), filepath);
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) throw Error('Outside root');
  if (sourceHash(fs.readFileSync(filepath, 'utf8')) !== request.sourceHash) throw Error('Source changed');
  fs.statSync(filepath);
  return 1;
}
const sources = files.map((file, i) => {
  const filepath = path.resolve(file), root = path.dirname(filepath), text = fs.readFileSync(filepath, 'utf8');
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  let line = Math.floor(lines.length / 2);
  while (line < lines.length - 1 && !/\S/u.test(lines[line])) line++;
  const column = Math.max(0, lines[line].search(/\S/u)) + 1;
  const request = { filepath, line: line + 1, column, sourceHash: sourceHash(text) };
  return { sample: i + 1, utf8Bytes: Buffer.byteLength(text), lines: lines.length,
    repeatedValidation: compare(() => readForwardSource(root, request).character,
      () => validateOnly(root, request), 30) };
});

const points = JSON.parse(fs.readFileSync(pointsFile, 'utf8'));
const { byPage } = indexPoints(points);
function wordIndex(words) {
  const result = new Map();
  for (const word of words) {
    const key = normalWord(word.text);
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(word);
  }
  return result;
}
const distance = (word, anchor) => (word.box[0] - anchor.x) ** 2 + (word.box[1] - anchor.y) ** 2;
function baseline(words, term, anchor) {
  return words.filter(w => term && normalWord(w.text) === term)
    .sort((a, b) => distance(a, anchor) - distance(b, anchor)).slice(0, 32);
}
function indexed(index, term, anchor) {
  return [...(index.get(term) || [])]
    .sort((a, b) => distance(a, anchor) - distance(b, anchor)).slice(0, 32);
}
const pages = [...byPage.values()].filter(words => words.length);
const step = Math.max(1, Math.ceil(pages.length / 8));
const samples = pages.filter((_page, i) => i % step === 0).map(words => {
  const index = wordIndex(words);
  const frequent = [...index].filter(([term]) => term).sort((a, b) => b[1].length - a[1].length)[0]?.[0];
  const terms = [...new Set([normalWord(words[0].text), normalWord(words[Math.floor(words.length / 2)].text), frequent])].filter(Boolean);
  const anchor = { x: words[0].box[0], y: words[0].box[1] };
  return { words, index, terms, anchor };
});
let comparisons = 0;
for (const { words, index, terms } of samples) {
  for (const anchorWord of [words[0], words[Math.floor(words.length / 2)], words.at(-1)]) {
    const anchor = { x: anchorWord.box[0], y: anchorWord.box[1] };
    for (const term of terms) {
      assert.deepEqual(indexed(index, term, anchor), baseline(words, term, anchor));
      comparisons++;
    }
  }
}
const consume = selected => selected.length + (selected[0]?.id || 0);
const caseCount = samples.reduce((n, p) => n + p.terms.length, 0);
assert.ok(caseCount > 0, 'The map contains no usable word-selection cases');
const selection = compare(
  () => samples.reduce((sum, p) => sum + p.terms.reduce((n, t) => n + consume(baseline(p.words, t, p.anchor)), 0), 0),
  () => samples.reduce((sum, p) => sum + p.terms.reduce((n, t) => n + consume(indexed(p.index, t, p.anchor)), 0), 0), 10);
selection.baselineMs /= caseCount;
selection.prototypeMs /= caseCount;
const indexBuildMs = median(Array.from({ length: 11 }, () => batch(() => {
  for (const sample of samples) checksum ^= wordIndex(sample.words).size;
  return 0;
}, 1))) / samples.length;
console.log(JSON.stringify({ scope: 'Warm filesystem/CPU microbenchmarks, not click-to-GUI latency',
  node: process.version, sources, candidateSelection: { points: points.length, pages: byPage.size,
    sampledPages: samples.length, sampledTerms: caseCount, orderComparisonsPassed: comparisons,
    ...selection, averagePageIndexBuildMs: indexBuildMs }, checksum }, null, 2));

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { indexPoints, nearestPoints, sourceMap } from './typst-sumatra.mjs';

const distance = (a, b) => ((a.box[0] + a.box[2] - b.box[0] - b.box[2]) / 2) ** 2
  + ((a.box[1] + a.box[3] - b.box[1] - b.box[3]) / 2) ** 2;

test('SyncTeX records preserve PDF coordinates, page numbers and compression', () => {
  const pages = [
    { width: 600, height: 800, words: [[10, 20, 30, 40, 'alpha']] },
    { width: 600, height: 800, words: [[50, 60, 70, 80, 'beta']] },
  ];
  const result = sourceMap(pages, '/home/test/doc.typst-sync.json');
  assert.deepEqual(gunzipSync(result.synctex), result.plain);
  assert.equal(result.points[0].id, 30 * 1024 + 20 + 1);
  assert.equal(result.points[1].id, 2097152 + 70 * 1024 + 60 + 1);
  assert.equal(result.points[1].page_no, 2);
  assert.ok(result.plain.toString().includes('(1,' + result.points[0].id + ':'));
  assert.equal(sourceMap(pages, '/home/test/map.json', false).synctex, null);
});

test('page-local top-eight selection agrees with the original full sort', () => {
  // Deterministic exhaustive comparison for every point in this generated corpus.
  const points = Array.from({ length: 800 }, (_, i) => ({
    id: i + 1, page_no: i % 4 + 1,
    box: [(i * 31) % 97, (i * 17) % 113, (i * 31) % 97 + 5, (i * 17) % 113 + 7],
  }));
  const { byId, byPage } = indexPoints(points);
  assert.equal(byId.size, 800);
  for (const word of points) {
    assert.equal(byId.get(word.id), word);
    const expected = points.filter(p => p.page_no === word.page_no && p.id !== word.id)
      .sort((a, b) => distance(a, word) - distance(b, word)).slice(0, 8);
    assert.deepEqual(nearestPoints(byPage.get(word.page_no), word), expected);
  }
});

test('empty pages, coincident points and stable distance ties', () => {
  const word = { id: 1, box: [0, 0, 0, 0] };
  const points = [word, ...Array.from({ length: 10 }, (_, i) => ({ id: i + 2, box: [1, 1, 1, 1] }))];
  assert.deepEqual(nearestPoints([], word), []);
  assert.deepEqual(nearestPoints(points, word).map(p => p.id), [2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(nearestPoints(points, word, 0), []);
});

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const sourceHash = text => crypto.createHash('sha256').update(text.replace(/^\uFEFF/, '')).digest('hex');

// VS Code columns count UTF-16 units; the pinned standalone mapper uses Unicode
// scalar columns (Typst 0.14.2 Lines::line_column_to_byte), not UTF-8 bytes.
export function sourcePosition(text, line, column) {
  if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1)
    throw Error('Invalid source line or column');
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  const row = lines[line - 1];
  if (row === undefined || column > row.length + 1) throw Error('Source position is outside the saved file');
  const prefix = row.slice(0, column - 1);
  if (/[\uD800-\uDBFF]$/.test(prefix)) throw Error('Source position splits a Unicode character');
  return { line: line - 1, character: [...prefix].length + (line === 1 && text.startsWith('\uFEFF') ? 1 : 0) };
}

export const normalWord = word => word.normalize('NFKC').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

export function readForwardSource(root, request) {
  if (typeof request.filepath !== 'string' || !path.isAbsolute(request.filepath) ||
      !request.filepath.endsWith('.typ')) throw Error('Forward search requires an absolute Typst file path');
  const filepath = fs.realpathSync(request.filepath);
  const relative = path.relative(fs.realpathSync(root), filepath);
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative))
    throw Error('Source is outside this document project');
  const text = fs.readFileSync(filepath, 'utf8');
  const hash = sourceHash(text);
  if (typeof request.sourceHash !== 'string' || request.sourceHash !== hash)
    throw Error('Source changed or is unsaved; save the file and click again');
  const position = sourcePosition(text, request.line, request.column);
  const row = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/)[request.line - 1];
  const token = [...row.matchAll(/\S+/gu)].find(m => m.index <= request.column - 1 && request.column - 1 < m.index + m[0].length);
  const bom = request.line === 1 && text.startsWith('\uFEFF') ? 1 : 0;
  return { filepath, ...position, hash, word: token ? normalWord(token[0]) : '',
    tokenStart: token ? [...row.slice(0, token.index)].length + bom : -1,
    tokenEnd: token ? [...row.slice(0, token.index + token[0].length)].length + bom : -1,
    modifiedAt: fs.statSync(filepath).mtimeMs };
}

// Tinymist's data plane emits binary UTF-8: jump,page x y[,page x y...].
// SVG frames share this socket. Only decode bounded jump frames, never the SVG.
export function parseJumpFrame(data) {
  const buffer = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
  if (buffer.length > 65536 || buffer.subarray(0, 5).toString() !== 'jump,') return null;
  const positions = buffer.toString('utf8').slice(5).split(',').filter(Boolean).map(item => {
    const values = item.trim().split(/\s+/).map(Number);
    if (values.length !== 3 || !Number.isInteger(values[0]) || values[0] < 1 ||
        !values.every(Number.isFinite) || values[1] < 0 || values[2] < 0)
      throw Error('Invalid source-to-PDF reply');
    return { page: values[0], x: values[1], y: values[2] };
  });
  return positions;
}

export function checkForwardRequest(response, deadline) {
  if (response.destroyed) throw Error('Forward search cancelled');
  if (Date.now() >= deadline) throw Error('Forward search request expired');
}

export async function refineForward(source, positions, { pageLookup, sourceCache, query, check }) {
  // Typst 0.14.2 gives span anchors. Verify matching words through inverse lookup.
  // The 32-probe cap is a latency choice, not a completeness claim.
  let probes = 0;
  for (const position of positions) {
    const candidates = (pageLookup.get(position.page) || []).filter(word =>
      source.word && normalWord(word.text) === source.word);
    candidates.sort((a, b) =>
      ((a.box[0] - position.x) ** 2 + (a.box[1] - position.y) ** 2) -
      ((b.box[0] - position.x) ** 2 + (b.box[1] - position.y) ** 2));
    for (const word of candidates) {
      if (++probes > 32) break;
      const [a, b, c, d] = word.box;
      const x = (a + c) / 2, y = (b + d) / 2;
      let mapped = sourceCache.get(word.id);
      if (!mapped || mapped.approximate) mapped = await query({ page_no: position.page, x, y });
      // Drain the untagged reply before observing cancellation. Releasing the
      // serial queue sooner could give this reply to a newer click.
      check();
      if (!mapped) continue;
      sourceCache.set(word.id, mapped);
      if (mapped.filepath === source.filepath && mapped.line === source.line + 1 &&
          mapped.column - 1 >= source.tokenStart && mapped.column - 1 < source.tokenEnd)
        return { page: position.page, x, y, record: word.id, candidatePages: positions.length,
          approximate: false, accuracy: 'word' };
    }
    if (probes > 32) break;
  }
  return forwardRecord(positions, pageLookup);
}

export function forwardRecord(positions, byPage) {
  // A macro may appear more than once. Use the first rendered occurrence with
  // text, and report the multiplicity rather than claiming a unique location.
  for (const position of positions) {
    let best, distance = Infinity;
    for (const word of byPage.get(position.page) || []) {
      const [x1, y1, x2, y2] = word.box;
      const dx = Math.max(x1 - position.x, 0, position.x - x2);
      const dy = Math.max(y1 - position.y, 0, position.y - y2);
      const d = dx * dx + dy * dy;
      if (d < distance) { best = word; distance = d; }
    }
    if (best) return { ...position, record: best.id, candidatePages: positions.length,
      approximate: true, accuracy: 'span' };
  }
  throw Error('No PDF text rectangle near this source location');
}

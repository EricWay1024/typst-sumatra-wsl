#!/usr/bin/env node
// A SyncTeX adapter for Typst: Sumatra selects a PDF word, then Tinymist resolves
// its position to the real source. No browser or VS Code preview is opened.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const here = path.dirname(self);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const metaPath = pdf => path.join(path.dirname(pdf), `.${path.basename(pdf, '.pdf')}.typst-sync.json`);
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeAtomic = (file, data) => {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, data);
  fs.renameSync(temp, file);
};

function findTinymist() {
  const compatible = path.join(os.homedir(), '.local/lib/typst-sumatra/bin/tinymist-0.14.20');
  if (fs.existsSync(compatible)) return compatible;
  throw Error('The Typst 0.14.2-compatible source mapper is missing.');
}

function cacheDirectory(config) {
  // Keep snapshots and logs in persistent project scratch, never the OS temp dir.
  const base = process.env.TYPST_SUMATRA_SCRATCH || [
    path.join(path.dirname(config.pdf), '.r2scratch'),
    path.join(config.root, 'scratch'),
  ].find(directory => fs.existsSync(directory));
  if (!base) throw Error('Set TYPST_SUMATRA_SCRATCH to a persistent project scratch directory.');
  const directory = path.join(path.resolve(base), 'typst-sumatra');
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

export function indexPoints(points) {
  const byId = new Map(), byPage = new Map();
  for (const point of points) {
    byId.set(point.id, point);
    if (!byPage.has(point.page_no)) byPage.set(point.page_no, []);
    byPage.get(point.page_no).push(point);
  }
  return { byId, byPage };
}

export function nearestPoints(candidates, word, limit = 8) {
  const best = [];
  for (const point of candidates) {
    if (point.id === word.id) continue;
    const d = distance(point, word);
    let at = 0;
    while (at < best.length && best[at].d <= d) at++;
    if (at < limit) {
      best.splice(at, 0, { point, d });
      if (best.length > limit) best.pop();
    }
  }
  return best.map(item => item.point);
}

function windowsPath(file) {
  const drive = file.match(/^\/mnt\/([a-z])\/(.*)$/i);
  if (drive) return `${drive[1].toUpperCase()}:\\${drive[2].replaceAll('/', '\\')}`;
  return `\\\\wsl.localhost\\${process.env.WSL_DISTRO_NAME || 'Ubuntu'}${file.replaceAll('/', '\\')}`;
}

export function sourceMap(pages, metadataFile, compress = true) {
  const sp = n => Math.round(n * 65536 * 72.27 / 72);
  // Coordinate-based record IDs stay meaningful while an older source map is
  // briefly cached by Sumatra after the PDF has already updated.
  const record = (page, box) => (page - 1) * 2097152
    + Math.min(2047, Math.max(0, Math.round((box[1] + box[3]) / 2))) * 1024
    + Math.min(1023, Math.max(0, Math.round((box[0] + box[2]) / 2))) + 1;
  const points = [];
  const lines = ['SyncTeX Version:1', `Input:1:${windowsPath(metadataFile)}`, 'Output:pdf',
    'Magnification:1000', 'Unit:1', 'X Offset:0', 'Y Offset:0', 'Content:'];
  for (const [index, page] of pages.entries()) {
    const first = record(index + 1, page.words[0] || [0, 0, 0, 0]);
    lines.push(`{${index + 1}`, `[1,${first}:0,${sp(page.height)}:${sp(page.width)},${sp(page.height)},0`);
    for (const word of page.words) {
      const id = record(index + 1, word);
      points.push({ id, page_no: index + 1, box: word.slice(0, 4), text: word[4] });
      const [x1, y1, x2, y2] = word;
      const x = sp(x1), y = sp(y2), width = sp(x2 - x1), height = sp(y2 - y1);
      // A real hbox with current-position children is required for the reference
      // SyncTeX parser to select individual words rather than the enclosing page.
      lines.push(`(1,${id}:${x},${y}:${width},${height},0`, `x1,${id}:${x},${y}`, `x1,${id}:${x + width},${y}`, ')');
    }
    lines.push(']', `}${index + 1}`);
  }
  lines.push('Postamble:', `Count:${lines.length}`, 'Post scriptum:');
  const plain = Buffer.from(lines.join('\n') + '\n');
  return { points, plain, synctex: compress ? gzipSync(plain) : null };
}

async function api(metadata, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1:${metadata.port}/${method === 'GET' ? 'status' : 'resolve'}`, {
    method, headers: { 'Authorization': `Bearer ${metadata.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(method === 'GET' ? 1500 : 20000),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || `Bridge HTTP ${response.status}`);
  return data;
}

async function existing(pdf) {
  try {
    const metadata = readJson(metaPath(pdf));
    return { metadata, status: await api(metadata) };
  } catch { return null; }
}

function parseArgs(args) {
  let root;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root') root = path.resolve(args[++i]);
    else positional.push(args[i]);
  }
  if (!positional[0]) throw Error('Usage: typst-sumatra watch|ensure [--root ROOT] INPUT.typ [OUTPUT.pdf]');
  const input = path.resolve(positional[0]);
  const pdf = path.resolve(positional[1] || input.replace(/\.typ$/i, '.pdf'));
  return { root: root || inferRoot(input), input, pdf };
}

function inferRoot(input) {
  for (let directory = path.dirname(input); directory !== path.dirname(directory); directory = path.dirname(directory)) {
    if (fs.existsSync(path.join(directory, 'typst.toml')) || fs.existsSync(path.join(directory, '.git'))) return directory;
  }
  return path.dirname(input);
}

async function ensure(config) {
  let active = await existing(config.pdf);
  if (!active) {
    const cache = cacheDirectory(config);
    const logFile = path.join(cache, crypto.createHash('sha256').update(config.pdf).digest('hex').slice(0, 16) + '.log');
    const output = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, [self, 'watch', '--root', config.root, config.input, config.pdf], {
      detached: true, stdio: ['ignore', output, output], cwd: config.root,
    });
    child.unref();
    fs.closeSync(output);
  }
  for (let attempt = 0; attempt < 160; attempt++) {
    active = await existing(config.pdf);
    if (active?.status.ready) return active.metadata;
    await pause(250);
  }
  throw Error(`The Typst bridge did not finish compiling. Check ${cacheDirectory(config)}/*.log.`);
}

async function watch(config) {
  if (await existing(config.pdf)) {
    console.error('A Sumatra source-map watcher is already running for this PDF.');
    return;
  }
  const { input, pdf, root } = config;
  const tinymist = findTinymist();
  const metadataFile = metaPath(pdf);
  const workspace = fs.mkdtempSync(path.join(cacheDirectory(config), 'session-'));
  let revision = 0, building = false, dirty = false, timer;
  let ready = fs.existsSync(pdf) && fs.statSync(pdf).size > 0, points = [], lastResolved = null;
  let mappingReady = false, snapshot = null, activeSnapshot = null, mapWorker = null;
  let mapperPromise = null, mapperReady = false, mapperPaused = false, idleTimer, warmupTimer, native;
  let shuttingDown = false, timings = {}, nativeStarted = 0;
  let sourceCache = new Map(), pointLookup = new Map(), pageLookup = new Map();
  let queue = Promise.resolve(), pending = null, child;
  let control, dataSocket, controlPort, dataPort, errorLog = '', logBuffer = '';
  const token = crypto.randomBytes(24).toString('hex');
  const metadata = { version: 3, ...config, token, port: 0, pid: process.pid };

  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const reply = (status, payload) => { response.statusCode = status; response.end(JSON.stringify(payload)); };
    if (request.headers.authorization !== `Bearer ${token}`) return reply(403, { error: 'Invalid bridge token' });
    if (request.method === 'GET' && request.url === '/status') return reply(200, {
      ready, mappingReady, input, pdf, lastResolved, timings, mapperRunning: !!child, mapperPaused,
      mapperReady, mapperPid: child?.pid ?? null, revision, cachedPositions: sourceCache.size,
    });
    if (request.method === 'POST' && request.url === '/shutdown') {
      reply(200, { stopped: true });
      setTimeout(() => shutdown(), 100);
      return;
    }
    if (request.method !== 'POST' || request.url !== '/resolve') return reply(404, { error: 'Unknown bridge request' });
    try {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 2048) throw Error('Request too large');
      }
      const id = JSON.parse(body).id;
      if (!Number.isInteger(id) || id < 1 || id > 2147483647) throw Error('Invalid PDF source position');
      const started = Date.now(), deadline = started + 20000;
      const result = queue.then(async () => {
        while (!mappingReady && Date.now() < deadline && !response.destroyed) await pause(40);
        if (response.destroyed || Date.now() >= deadline) throw Error('Source lookup request expired');
        if (!ready || !mappingReady) throw Error('The PDF is updated; source mapping is still catching up.');
        const version = revision;
        const cached = sourceCache.get(id);
        if (cached) { timings.lastResolveCacheHit = true; return cached; }
        timings.lastResolveCacheHit = false;
        try {
          await ensureMapper();
          if (version !== revision || !mappingReady) throw Error('The PDF changed during source lookup; click again.');
          const resolved = await resolveWord(id);
          if (version !== revision || !mappingReady) throw Error('The PDF changed during source lookup; click again.');
          sourceCache.set(id, resolved);
          return resolved;
        } finally { scheduleMapperPause(); }
      });
      queue = result.catch(() => {});
      const resolved = await result;
      timings.lastResolveMs = Date.now() - started;
      lastResolved = { ...resolved, record: id, time: new Date().toISOString() };
      reply(200, resolved);
    } catch (error) { reply(500, { error: error.message }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  metadata.port = server.address().port;
  writeAtomic(metadataFile, JSON.stringify(metadata));

  function schedule() {
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(build, 200);
  }

  async function build() {
    if (building || !dirty) return;
    building = true; dirty = false;
    const version = revision;
    activeSnapshot = snapshot;
    try {
      if (!activeSnapshot) return;
      const pointsFile = path.join(workspace, 'points.json');
      const mapFile = path.join(workspace, 'map.synctex');
      await new Promise((resolve, reject) => {
        const worker = mapWorker = spawn('nice', ['-n', '19', process.execPath,
          path.join(here, 'map-worker.mjs'), activeSnapshot, metadataFile, pointsFile, mapFile],
          { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
        let errors = '';
        worker.stderr.on('data', data => { errors += data; });
        worker.on('error', reject);
        worker.on('exit', code => {
          if (mapWorker === worker) mapWorker = null;
          code === 0 ? resolve() : reject(Error(errors || 'Mapping superseded by a newer PDF'));
        });
      });
      if (version !== revision) { dirty = true; return; }
      // Sumatra 3.5 watches the uncompressed file, with one-second timestamps.
      // Publish a strictly newer timestamp without delaying PDF compilation.
      const syncFile = pdf.replace(/\.pdf$/i, '.synctex');
      let oldSecond = 0;
      try { oldSecond = Math.floor(fs.statSync(syncFile).mtimeMs / 1000); } catch {}
      if (Math.floor(Date.now() / 1000) <= oldSecond) await pause((oldSecond + 1) * 1000 - Date.now() + 5);
      if (version !== revision) { dirty = true; return; }
      points = readJson(pointsFile);
      ({ byId: pointLookup, byPage: pageLookup } = indexPoints(points));
      writeAtomic(syncFile, fs.readFileSync(mapFile));
      sourceCache = new Map();
      mappingReady = true;
      timings.mappingUpdatedAt = new Date().toISOString();
      timings.mappingLagMs = Date.now() - Date.parse(timings.pdfUpdatedAt);
      console.error(`Source map ready ${timings.mappingLagMs} ms after PDF (${points.length} words).`);
      // A resource-starved warmup may have timed out while PDF extraction was
      // still pending. Give the newly published revision a fresh warmup then.
      if (!child && !mapperPromise) scheduleMapperWarmup();
    } catch (error) {
      if (version === revision) console.error(`Source mapping failed; PDF is already updated: ${error.message}`);
    } finally {
      if (activeSnapshot) {
        try { fs.unlinkSync(activeSnapshot); } catch {}
        if (snapshot === activeSnapshot) snapshot = null;
      }
      activeSnapshot = null;
      building = false;
      if (dirty) timer = setTimeout(build, 150);
    }
  }

  async function resolveWord(id) {
    const encoded = id - 1;
    const x = encoded % 1024, y = Math.floor(encoded / 1024) % 2048;
    const word = pointLookup.get(id) || {
      id, page_no: Math.floor(encoded / 2097152) + 1, box: [x - .4, y - .4, x + .4, y + .4],
    };
    const [x1, y1, x2, y2] = word.box;
    for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.65], [0.5, 0.35]]) {
      const result = await query({ page_no: word.page_no, x: x1 + (x2 - x1) * fx, y: y1 + (y2 - y1) * fy });
      if (result) return result;
    }
    // Generated labels and page counters may lack a source span. Use nearby text
    // on the same page, as PDF-to-source navigation normally does for whitespace.
    const nearby = nearestPoints(pageLookup.get(word.page_no) || [], word);
    for (const item of nearby) {
      const [a, b, c, d] = item.box;
      const result = await query({ page_no: item.page_no, x: (a + c) / 2, y: (b + d) / 2 });
      if (result) return { ...result, approximate: true };
    }
    throw Error('No Typst source position was found near this PDF text.');
  }

  function query(position) {
    return new Promise((resolve, reject) => {
      if (!dataSocket || dataSocket.readyState !== WebSocket.OPEN) return reject(Error('Typst source mapper disconnected'));
      const deadline = setTimeout(() => {
        pending.fail(Error('Typst source-position query timed out'));
        // Replies have no request IDs. Discard this connection so a late reply
        // cannot be mistaken for the result of the next click.
        stopMapper();
      }, 3000);
      pending = result => { clearTimeout(deadline); pending = null; resolve(result); };
      pending.fail = error => { clearTimeout(deadline); pending = null; reject(error); };
      try { dataSocket.send('src-point ' + JSON.stringify(position)); }
      catch (error) { pending.fail(error); stopMapper(); };
    });
  }

  function stopMapper() {
    clearTimeout(idleTimer);
    const previous = child;
    child = null; mapperPromise = null; mapperReady = false; mapperPaused = false;
    control?.close(); dataSocket?.close();
    control = null; dataSocket = null;
    pending?.fail(Error('Source lookup was interrupted by a PDF update or mapper shutdown'));
    if (previous) { previous.kill('SIGCONT'); previous.kill(); }
  }

  function scheduleMapperWarmup() {
    clearTimeout(warmupTimer);
    const version = revision;
    // Debounce edits: do not put a second compiler on the PDF publication path.
    warmupTimer = setTimeout(async () => {
      if (shuttingDown || version !== revision) return;
      const started = Date.now();
      try {
        await ensureMapper();
        if (version === revision) timings.mapperWarmupMs = Date.now() - started;
      } catch (error) {
        if (version === revision && !shuttingDown) console.error(`Source mapper warmup: ${error.message}`);
      } finally {
        if (version === revision) scheduleMapperPause();
      }
    }, 350);
  }

  function scheduleMapperPause() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (child && !pending) { child.kill('SIGSTOP'); mapperPaused = true; }
    }, 800);
  }

  async function ensureMapper() {
    clearTimeout(idleTimer);
    if (child && mapperPaused) { child.kill('SIGCONT'); mapperPaused = false; }
    if (mapperReady && dataSocket?.readyState === WebSocket.OPEN) return;
    if (mapperPromise) return mapperPromise;
    if (child) stopMapper();
    let instance;
    const starting = (async () => {
      controlPort = null; dataPort = null; errorLog = ''; logBuffer = '';
      instance = child = spawn('nice', ['-n', '19', tinymist,
        '--log-filter', 'tinymist_preview::actor::render=debug,tinymist=info',
        'preview', '--no-open', '--root', root, '--data-plane-host', '127.0.0.1:0',
        '--control-plane-host', '127.0.0.1:0', input],
        { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
      instance.stderr.on('data', chunk => {
        if (child !== instance) return;
        const text = chunk.toString();
        errorLog = (errorLog + text).slice(-12000);
        logBuffer += text;
        let newline;
        while ((newline = logBuffer.indexOf('\n')) !== -1) {
          const line = logBuffer.slice(0, newline); logBuffer = logBuffer.slice(newline + 1);
          controlPort ||= line.match(/Control (?:plane|panel) server listening on: 127\.0\.0\.1:(\d+)/)?.[1];
          dataPort ||= line.match(/Data plane server listening on: 127\.0\.0\.1:(\d+)/)?.[1];
          if (line.includes('resolved WebviewResolveFrameLoc: None')) pending?.(null);
          if (line.includes('compilation succeeded')) mapperReady = true;
        }
      });
      instance.on('error', error => {
        errorLog += error.message;
        if (child === instance) stopMapper();
      });
      instance.on('exit', () => {
        if (child === instance) stopMapper();
      });
      for (let attempt = 0; attempt < 200 && (!controlPort || !dataPort); attempt++) {
        if (child !== instance) throw Error('Source lookup was superseded by a PDF update');
        await pause(50);
      }
      if (!controlPort || !dataPort) throw Error('Tinymist source mapper did not start: ' + errorLog);
      const socket = port => new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Origin: `http://127.0.0.1:${port}` } });
      control = socket(controlPort);
      dataSocket = socket(dataPort);
      for (const ws of [control, dataSocket]) ws.addEventListener('close', () => {
        if (child !== instance) return;
        mapperReady = false;
        pending?.fail(Error('Typst source mapper disconnected'));
      });
      control.addEventListener('message', event => {
        if (child !== instance) return;
        const message = JSON.parse(event.data);
        if (message.event === 'editorScrollTo') {
          const position = message.start || message.end;
          pending?.({ filepath: message.filepath, line: position[0] + 1, column: position[1] + 1 });
        } else if (message.event === 'compileStatus') {
          if (message.kind === 'Compiling') mapperReady = false;
          if (message.kind === 'CompileSuccess') mapperReady = true;
        }
      });
      await Promise.all([control, dataSocket].map(ws => new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
      })));
      for (let attempt = 0; attempt < 200 && !mapperReady; attempt++) {
        if (child !== instance) throw Error('Source lookup was superseded by a PDF update');
        await pause(50);
      }
      if (!mapperReady) throw Error('Typst source lookup compilation failed: ' + errorLog);
      await pause(20);
    })();
    mapperPromise = starting;
    try { await starting; }
    catch (error) { if (child === instance) stopMapper(); throw error; }
    finally { if (mapperPromise === starting) mapperPromise = null; }
  }

  function stopMappingWorker() {
    if (mapWorker) {
      try { process.kill(-mapWorker.pid, 'SIGTERM'); } catch { mapWorker.kill(); }
    }
  }

  const nativeTypst = path.join(os.homedir(), '.cargo/bin/typst');
  native = spawn(nativeTypst, ['watch', '--no-pdf-tags', '--root', root, input, pdf],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let nativeBuffer = '';
  const nativeLog = chunk => {
    process.stderr.write(chunk);
    nativeBuffer += chunk.toString().replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    let newline;
    while ((newline = nativeBuffer.indexOf('\n')) !== -1) {
      const line = nativeBuffer.slice(0, newline); nativeBuffer = nativeBuffer.slice(newline + 1);
      if (line.includes('compiling ...')) {
        revision++; nativeStarted = Date.now(); mappingReady = false;
        dirty = false; clearTimeout(timer); clearTimeout(warmupTimer);
        stopMappingWorker(); stopMapper(); sourceCache.clear();
      } else if (line.includes('compiled successfully')) {
        // typst watch has already closed and published the PDF at this point.
        // This handler schedules mapping only; it never compiles or writes PDFs.
        ready = true;
        const duration = line.match(/in ([\d.]+) (µs|us|ms|s)/);
        timings = { pdfUpdatedAt: new Date().toISOString(),
          nativeCompileMs: duration ? Number(duration[1]) * ({ 'µs': .001, us: .001, ms: 1, s: 1000 }[duration[2]]) : Date.now() - nativeStarted };
        if (snapshot && snapshot !== activeSnapshot) { try { fs.unlinkSync(snapshot); } catch {} }
        snapshot = path.join(workspace, `document-${revision}.pdf`);
        fs.copyFileSync(pdf, snapshot);
        schedule();
        scheduleMapperWarmup();
      }
    }
  };
  native.stdout.on('data', nativeLog);
  native.stderr.on('data', nativeLog);
  native.on('error', error => { console.error(error.message); shutdown(1); });
  native.on('exit', code => { if (!shuttingDown) shutdown(code || 1); });

  function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    clearTimeout(timer); clearTimeout(warmupTimer);
    native?.kill();
    stopMapper(); stopMappingWorker();
    server.close();
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch {}
    process.exit(code);
  }
  process.on('SIGTERM', () => shutdown());
  process.on('SIGINT', () => shutdown());
}

function distance(a, b) {
  return ((a.box[0] + a.box[2] - b.box[0] - b.box[2]) / 2) ** 2
    + ((a.box[1] + a.box[3] - b.box[1] - b.box[3]) / 2) ** 2;
}

function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', d => { output += d; });
    child.stderr.on('data', d => { errors += d; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(output) : reject(Error(errors || `${executable} exited ${code}`)));
  });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'watch') await watch(parseArgs(args));
  else if (command === 'ensure') await ensure(parseArgs(args));
  else if (command === 'ensure-pdf') {
    const pdf = path.resolve(args[0]);
    let config;
    try { config = readJson(metaPath(pdf)); } catch {}
    const input = config?.input || pdf.replace(/\.pdf$/i, '.typ');
    if (fs.existsSync(input)) await ensure({ root: config?.root || inferRoot(input), input, pdf });
  } else if (command === 'resolve') {
    const file = path.resolve(args[0]);
    if (!file.endsWith('.typst-sync.json')) throw Error('Not a Typst SyncTeX source map');
    const old = readJson(file);
    const metadata = await ensure({ root: old.root, input: old.input, pdf: old.pdf });
    const result = await api(metadata, 'POST', { id: Number(args[1]) });
    console.log(JSON.stringify(result));
  } else throw Error('Usage: typst-sumatra watch|ensure|ensure-pdf|resolve ...');
}

if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  main().catch(error => { console.error(error.message); process.exit(1); });
}

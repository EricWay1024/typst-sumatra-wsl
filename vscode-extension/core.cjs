const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

const hash = text => crypto.createHash('sha256').update(text.replace(/^\uFEFF/, '')).digest('hex');
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('../') && !path.isAbsolute(relative);
};
const metadataPath = pdf => path.join(path.dirname(pdf), `.${path.basename(pdf, '.pdf')}.typst-sync.json`);

// Links carry only source coordinates/version, never a bridge capability token.
function* words(text) {
  const lines = text.split(/\r\n|\n|\r/);
  for (let line = 0; line < lines.length; line++) {
    for (const match of lines[line].matchAll(/\S+/gu))
      yield { line, character: match.index, end: match.index + match[0].length };
  }
}

async function loadMetadata(file, source) {
  if ((await fs.stat(file)).size > 65536) throw Error('Invalid bridge metadata');
  const value = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
      typeof value.token !== 'string' || !value.token || typeof value.root !== 'string' ||
      !path.isAbsolute(value.root) || typeof value.pdf !== 'string' || !path.isAbsolute(value.pdf) ||
      typeof value.input !== 'string' || !inside(value.root, source)) throw Error('Invalid bridge metadata for this source');
  return { ...value, metadataFile: file };
}

async function candidates(source, root) {
  const result = [];
  for (let directory = path.dirname(source); inside(root, directory); directory = path.dirname(directory)) {
    try {
      for (const name of await fs.readdir(directory))
        if (name.startsWith('.') && name.endsWith('.typst-sync.json')) result.push(path.join(directory, name));
    } catch { /* An inaccessible ancestor is not a usable bridge. */ }
    if (directory === root || directory === path.dirname(directory)) break;
  }
  return result;
}

async function request(metadata, route, body, { signal, timeout = 25000 } = {}) {
  // A metadata file cannot supply a hostname or redirect the bearer token.
  const response = await fetch(`http://127.0.0.1:${metadata.port}/${route}`, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: { Authorization: `Bearer ${metadata.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || `Bridge HTTP ${response.status}`);
  return result;
}

function linuxExecutable(file) {
  if (file.startsWith('/')) return file;
  const match = /^([a-z]):[\\/](.*)$/i.exec(file);
  if (!match) throw Error('Sumatra path must be an absolute WSL or Windows drive path');
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}`;
}

async function findSumatra(configured) {
  const choices = [];
  if (configured) choices.push(linuxExecutable(configured));
  else {
    const { stdout } = await promisify(execFile)('/mnt/c/Windows/System32/cmd.exe',
      ['/d', '/c', 'echo %LOCALAPPDATA%'], { cwd: '/mnt/c/Windows', timeout: 5000, encoding: 'utf8' });
    choices.push(linuxExecutable(stdout.trim()) + '/SumatraPDF/SumatraPDF.exe',
      '/mnt/c/Program Files/SumatraPDF/SumatraPDF.exe', '/mnt/c/Program Files (x86)/SumatraPDF/SumatraPDF.exe');
  }
  for (const file of choices) { try { await fs.access(file); return file; } catch {} }
  throw Error('SumatraPDF.exe not found. Set typstSumatra.sumatraPath in your user settings.');
}

function sumatraArguments(target) {
  if (!Number.isInteger(target.record) || target.record < 1 || target.record > 2147483647 ||
      typeof target.pdf !== 'string' || !target.pdf.toLowerCase().endsWith('.pdf') ||
      typeof target.source !== 'string' || !target.source.endsWith('.typst-sync.json') ||
      ![target.pdf, target.source].every(file => /^(?:[a-z]:[\\/]|\\\\)/i.test(file)))
    throw Error('Invalid forward-search target from bridge');
  return ['-reuse-instance', '-forward-search', target.source, String(target.record), target.pdf];
}

function launchSumatra(executable, target) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, sumatraArguments(target), {
      cwd: '/mnt/c/Windows', stdio: 'ignore', detached: true,
    });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

module.exports = { hash, inside, metadataPath, words, loadMetadata, candidates, request,
  linuxExecutable, findSumatra, sumatraArguments, launchSumatra };

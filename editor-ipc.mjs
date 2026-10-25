// The same local HTTP protocol used by VS Code's remote CLI. No extension is
// installed, and no Code/Node subprocess is needed to open a source location.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

export function editorSocket({ env = process.env, uid = process.getuid?.(),
  stat = fs.lstatSync, sockets = () => fs.readFileSync('/proc/net/unix', 'utf8') } = {}) {
  const ownedSocket = file => {
    try { const s = stat(file); return s.isSocket() && s.uid === uid; } catch { return false; }
  };
  // A watcher started in the intended VS Code terminal already has its window's
  // explicit handle. Never replace a stale explicit binding with another window.
  if (env.VSCODE_IPC_HOOK_CLI) {
    const file = env.VSCODE_IPC_HOOK_CLI;
    return ownedSocket(file) ? { socketPath: file } : { reason: 'stale-editor-binding' };
  }
  let table;
  try { table = sockets(); } catch { return { reason: 'editor-discovery-unavailable' }; }
  const candidates = new Set();
  for (const row of table.split('\n')) {
    const fields = row.trim().split(/\s+/);
    if (fields.length < 8 || !(parseInt(fields[3], 16) & 0x10000)) continue;
    const file = fields.slice(7).join(' ');
    if (/\/vscode-ipc-[\w-]+\.sock$/.test(file) && ownedSocket(file)) candidates.add(file);
  }
  // Filesystem socket entries can outlive their server. /proc/net/unix lists
  // active listeners; selecting only a unique one avoids the wrong editor window.
  if (candidates.size !== 1) return { reason: candidates.size ? 'multiple-editor-windows' : 'no-editor' };
  return { socketPath: candidates.values().next().value };
}

export function editorOpenMessage(position, distro = process.env.WSL_DISTRO_NAME) {
  const { filepath, line, column } = position;
  if (typeof filepath !== 'string' || !path.isAbsolute(filepath) || filepath.includes('\0') ||
      !Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) {
    throw Error('Invalid editor source position');
  }
  return {
    type: 'open',
    fileURIs: [pathToFileURL(`${filepath}:${line}:${column}`).href],
    gotoLineMode: true,
    forceReuseWindow: true,
    ...(distro ? { remoteAuthority: `wsl+${distro}` } : {}),
  };
}

function sendOpen(socketPath, message, timeoutMs) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(message));
    const request = http.request({ socketPath, path: '/', method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Content-Length': body.length },
    }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 65536) request.destroy(Error('Editor reply too large'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode !== 200 || result !== null) throw Error('Editor rejected the open request');
          resolve();
        } catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => request.destroy(Error('Editor request timed out')), timeoutMs);
    request.on('error', reject);
    request.on('close', () => clearTimeout(timer));
    request.end(body);
  });
}

export async function openInEditor(position, { discover = editorSocket, timeoutMs = 1500,
  distro = process.env.WSL_DISTRO_NAME } = {}) {
  const started = performance.now();
  const target = discover();
  if (!target.socketPath) return { opened: false, transport: 'cli-fallback', reason: target.reason, elapsedMs: 0 };
  try {
    await sendOpen(target.socketPath, editorOpenMessage(position, distro), timeoutMs);
    return { opened: true, transport: 'vscode-ipc', elapsedMs: Math.round(performance.now() - started) };
  } catch (error) {
    return { opened: false, transport: 'cli-fallback', reason: error.message,
      elapsedMs: Math.round(performance.now() - started) };
  }
}

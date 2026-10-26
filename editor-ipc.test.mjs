import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { editorSocket, editorOpenMessage, openInEditor, createEditorBinding } from './editor-ipc.mjs';

const position = { filepath: '/home/test/space # percent % résumé.typ', line: 12, column: 4 };
const stat = () => ({ uid: 42, isSocket: () => true });
const row = (file, flags = '00010000') => `000: 2 0 ${flags} 0001 01 42 ${file}`;
const a = '/run/user/42/vscode-ipc-a.sock', b = '/run/user/42/vscode-ipc-b.sock';
const choose = (table, extra = {}) => editorSocket({ env: {}, uid: 42, stat, sockets: () => table, ...extra });

test('discovery selects only a unique active owned listener, not stale files or other services', () => {
  assert.deepEqual(choose(row(a)), { socketPath: a });
  assert.deepEqual(choose([row(a), row(a, '00000000'), row('/run/user/42/vscode-git-a.sock')].join('\n')), { socketPath: a });
  assert.equal(choose([row(a), row(b)].join('\n')).reason, 'multiple-editor-windows');
  assert.equal(choose(row(a), { uid: 43 }).reason, 'no-editor');
  assert.equal(choose(row(a), { stat: () => ({ uid: 42, isSocket: () => false }) }).reason, 'no-editor');
  assert.equal(choose(row(a), { stat: () => { throw Error('gone'); } }).reason, 'no-editor');
  assert.equal(choose('', { sockets: () => { throw Error('no procfs'); } }).reason, 'editor-discovery-unavailable');
});

test('an explicit window binding wins; a stale binding does not redirect to another window', () => {
  assert.deepEqual(choose(row(b), { env: { VSCODE_IPC_HOOK_CLI: a } }), { socketPath: a });
  assert.equal(choose(row(b), { env: { VSCODE_IPC_HOOK_CLI: a }, stat: file => {
    if (file === a) throw Error('gone'); return stat();
  } }).reason, 'stale-editor-binding');
});

test('a project registration renews a dead binding, but automatic renewal cannot steal a live window', () => {
  let table = row(b);
  const binding = createEditorBinding('/project/main.typ', { env: { VSCODE_IPC_HOOK_CLI: a },
    uid: 42, stat, realpath: p => p, sockets: () => table });
  const request = { socketPath: b, workspaceFolders: ['/project'] };
  assert.deepEqual(binding.register(request), { bound: true });
  assert.deepEqual(binding.discover(), { socketPath: b });
  table = [row(a), row(b)].join('\n');
  assert.deepEqual(binding.register({ ...request, socketPath: a }), { bound: false, reason: 'another-live-window-bound' });
  assert.equal(binding.discover().socketPath, b);
  assert.deepEqual(binding.register({ ...request, socketPath: a, explicit: true }), { bound: true });
  assert.equal(binding.discover().socketPath, a);
  table = row(b);
  assert.deepEqual(binding.register(request), { bound: true }, 'Reload can renew again without restarting the bridge');
});

test('registration rejects other projects, invalid socket types/owners and non-listeners', () => {
  const options = { env: {}, uid: 42, stat, realpath: p => p, sockets: () => row(a) };
  const request = { socketPath: a, workspaceFolders: ['/project'] };
  const binding = createEditorBinding('/project/main.typ', options);
  for (const workspaceFolders of [[], ['/project-other'], ['/project/main'], ['relative'], null])
    assert.throws(() => binding.register({ ...request, workspaceFolders }));
  for (const socketPath of [b, '/run/user/42/not-vscode.sock', null, 42])
    assert.throws(() => binding.register({ ...request, socketPath }));
  for (const overrides of [{ uid: 43 }, { stat: () => ({ uid: 42, isSocket: () => false }) }, { sockets: () => row(a, '00000000') }])
    assert.throws(() => createEditorBinding('/project/main.typ', { ...options, ...overrides }).register(request));
  assert.deepEqual(binding.register(request), { bound: true });
});

test('goto protocol preserves Unicode, spaces, URI metacharacters and one-based coordinates', () => {
  const message = editorOpenMessage(position, 'Test Distro');
  assert.equal(message.type, 'open');
  assert.equal(fileURLToPath(message.fileURIs[0]), position.filepath + ':12:4');
  assert.equal(message.forceReuseWindow, true);
  assert.equal(message.gotoLineMode, true);
  assert.equal(message.remoteAuthority, 'wsl+Test Distro');
  for (const bad of [{ line: 0 }, { column: 1.5 }, { filepath: 'relative.typ' }, { filepath: '/bad\0name' }]) {
    assert.throws(() => editorOpenMessage({ ...position, ...bad }));
  }
});

let sequence = 0;
async function mock(t, handler) {
  // A short, persistent project path: Unix sockets have a small pathname limit.
  const scratch = fileURLToPath(new URL('./scratch/', import.meta.url));
  fs.mkdirSync(scratch, { recursive: true });
  const socketPath = path.join(scratch, `ipc-${process.pid}-${sequence++}.sock`);
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    handler(JSON.parse(body), response);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { discover: () => ({ socketPath }), timeoutMs: 300, distro: 'Ubuntu' };
}

test('acknowledged opens reuse the running editor without an executable', async t => {
  const messages = [];
  const options = await mock(t, (message, response) => {
    messages.push(message); response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('null');
  });
  for (let i = 0; i < 2; i++) {
    const result = await openInEditor(position, options);
    assert.equal(result.opened, true);
    assert.equal(result.transport, 'vscode-ipc');
  }
  assert.deepEqual(messages, [editorOpenMessage(position, 'Ubuntu'), editorOpenMessage(position, 'Ubuntu')]);
});

for (const [name, status, body] of [
  ['server refusal', 500, '"refused"'], ['malformed reply', 200, 'not JSON'],
  ['wrong protocol', 200, '"not an open acknowledgement"'], ['oversized reply', 200, 'x'.repeat(70000)],
]) test(`${name} falls back to the normal CLI`, async t => {
  const options = await mock(t, (_, response) => { response.writeHead(status); response.end(body); });
  const result = await openInEditor(position, options);
  assert.equal(result.opened, false);
  assert.equal(result.transport, 'cli-fallback');
  assert.ok(result.reason);
});

test('unresponsive editor has a bounded timeout', async t => {
  const options = await mock(t, () => {});
  const result = await openInEditor(position, { ...options, timeoutMs: 30 });
  assert.equal(result.opened, false);
  assert.match(result.reason, /timed out/);
});

test('missing, ambiguous and disconnected editors fall back', async () => {
  for (const reason of ['no-editor', 'multiple-editor-windows']) {
    assert.equal((await openInEditor(position, { discover: () => ({ reason }) })).reason, reason);
  }
  const result = await openInEditor(position, { discover: () => ({ socketPath: '/nonexistent/typst-sumatra.sock' }) });
  assert.equal(result.opened, false);
});

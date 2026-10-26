const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const core = require('./core.cjs');
const { createExtension, activate } = require('./extension.cjs');

function fixture(overrides = {}) {
  const calls = [], warnings = [], logs = [], registered = [], decorations = [], styles = [], events = {};
  const text = 'α 𝒜 needle\nsecond line';
  const uri = { scheme: 'file', fsPath: '/project/chapter.typ', toString: () => 'file:///project/chapter.typ' };
  const document = { uri, version: 1, languageId: 'typst', isDirty: false, lineCount: 2,
    getText: () => text, lineAt: i => ({ text: text.split('\n')[i] }) };
  const target = { page: 2, record: 123, revision: 1, accuracy: 'word',
    pdf: '\\\\wsl.localhost\\Ubuntu\\project\\main.pdf', source: '\\\\wsl.localhost\\Ubuntu\\project\\.main.typst-sync.json' };
  const vscode = {
    env: { remoteName: 'wsl' },
    Range: class { constructor(...args) { this.args = args; } },
    DocumentLink: class { constructor(range) { this.range = range; } },
    Uri: { parse: value => ({ toString: () => value }), file: fsPath => ({ fsPath }) },
    EventEmitter: class { constructor() { this.event = () => {}; } fire() {} dispose() {} },
    RelativePattern: class {},
    workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: '/project' } }],
      createFileSystemWatcher: () => ({ dispose() {},
        onDidCreate: listener => { events.metadataCreate = listener; return { dispose() {} }; },
        onDidChange: listener => { events.metadataChange = listener; return { dispose() {} }; } }),
      getWorkspaceFolder: () => ({ uri: { fsPath: '/project' } }),
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      onDidChangeConfiguration: listener => { events.configuration = listener; return { dispose() {} }; },
      onDidChangeTextDocument: listener => { events.document = listener; return { dispose() {} }; },
      findFiles: async () => [] },
    window: { activeTextEditor: { document, selection: { active: { line: 0, character: 5 } },
        setDecorations: (style, ranges) => decorations.push({ style, ranges }) },
      createTextEditorDecorationType: options => {
        const style = { options, dispose() { this.disposed = true; } }; styles.push(style); return style;
      },
      onDidChangeVisibleTextEditors: listener => { events.visible = listener; return { dispose() {} }; },
      onDidChangeActiveTextEditor: listener => { events.active = listener; return { dispose() {} }; },
      onDidChangeWindowState: listener => { events.focus = listener; return { dispose() {} }; },
      createOutputChannel: () => ({ appendLine: text => logs.push(text), dispose() {} }),
      showWarningMessage: text => warnings.push(text), showQuickPick: async picks => picks[0] },
    languages: { registerDocumentLinkProvider: (selector, provider) => { registered.push({ selector, provider }); return {}; } },
    commands: { registerCommand: (name, handler) => { registered.push({ name, handler }); return {}; } },
  };
  vscode.window.visibleTextEditors = [vscode.window.activeTextEditor];
  const context = { subscriptions: [], workspaceState: { get: () => undefined, update: async () => {} } };
  const dependencies = {
    editorSocket: () => undefined,
    candidates: async () => ['/project/.main.typst-sync.json'],
    loadMetadata: async file => ({ version: 4, metadataFile: file, input: '/project/main.typ', pdf: '/project/main.pdf', token: 'test-secret' }),
    request: async (_meta, route, body) => {
      calls.push({ route, body });
      return route === 'status' ? { forwardSearch: true, revision: 1, mappingReady: true } : target;
    },
    findSumatra: async () => '/fake/SumatraPDF.exe',
    launchSumatra: async (exe, target) => calls.push({ exe, target }),
    ...overrides,
  };
  const api = createExtension(vscode, context, dependencies);
  return { api, vscode, context, document, target, calls, warnings, logs, registered, dependencies, decorations, styles, events };
}

test('link registration is Typst-only and does not replace F12 or add global keybindings', () => {
  const f = fixture();
  const Module = require('node:module'), original = Module._load;
  try {
    Module._load = function(id, ...args) { return id === 'vscode' ? f.vscode : original.call(this, id, ...args); };
    activate(f.context);
  } finally { Module._load = original; }
  assert.deepEqual(f.registered[0].selector, { language: 'typst', scheme: 'file', pattern: '**/*.typ' });
  assert.deepEqual(f.registered.slice(1).map(r => r.name), ['typstSumatra.showInPdf', 'typstSumatra.selectPdf']);
  assert.equal(require('./package.json').contributes.keybindings, undefined);
  for (const subscription of f.context.subscriptions) subscription.dispose?.();
});

test('word links preserve UTF-16 coordinates; hovering performs no lookup or launch', () => {
  const f = fixture(), links = f.api.links.provideDocumentLinks(f.document, {});
  const link = links.find(l => l.source[3] === 5);
  assert.deepEqual(link.range.args, [0, 5, 0, 11]);
  const url = f.api.links.resolveDocumentLink(link).target.toString();
  assert.deepEqual(JSON.parse(decodeURIComponent(url.split('?')[1])), [f.document.uri.toString(), 1, 0, 5]);
  assert.ok(!url.includes('test-secret'));
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.api.links.provideDocumentLinks({ ...f.document, languageId: 'javascript' }, {}), []);
  assert.deepEqual(f.api.links.provideDocumentLinks(f.document, { isCancellationRequested: true }), []);
  f.vscode.workspace.isTrusted = false;
  assert.deepEqual(f.api.links.provideDocumentLinks(f.document, {}), []);
});

test('PDF links are not permanently underlined; other languages keep their link styling', () => {
  const f = fixture();
  assert.deepEqual(f.styles[0].options, { textDecoration: 'none !important' });
  assert.deepEqual(f.decorations.at(-1).ranges.map(r => r.args), [[0, 0, 1, 11]]);
  f.document.lineAt = () => ({ text: 'edited line' });
  f.events.document({ document: f.document });
  assert.equal(f.decorations.length, 2);
  const other = { ...f.document, languageId: 'javascript' }, otherDecorations = [];
  f.vscode.window.visibleTextEditors.push({ document: other, setDecorations: (_style, ranges) => otherDecorations.push(ranges) });
  f.events.visible();
  assert.deepEqual(otherDecorations, [[]]);
  f.vscode.workspace.getConfiguration = () => ({ get: () => false });
  f.events.configuration({ affectsConfiguration: () => true });
  assert.deepEqual(f.decorations.at(-1).ranges, []);
  assert.deepEqual(f.api.links.provideDocumentLinks(f.document, {}), []);
  for (const subscription of f.context.subscriptions) subscription.dispose();
  assert.equal(f.styles[0].disposed, true);
});

test('click sends a content hash and coordinates, then launches only the returned PDF target', async () => {
  const f = fixture();
  await f.api.show(f.document.uri.toString(), 1, 0, 5);
  assert.deepEqual(f.calls.find(c => c.route === 'forward').body,
    { filepath: f.document.uri.fsPath, line: 1, column: 6, sourceHash: core.hash(f.document.getText()) });
  assert.equal(f.calls.at(-1).exe, '/fake/SumatraPDF.exe');
  assert.equal(f.calls.at(-1).target, f.target);
  assert.deepEqual(f.warnings, []);
});

test('activation/restart binding uses this window and project; source clicks explicitly select their window', async () => {
  let socket = '/run/user/42/vscode-ipc-first.sock';
  const f = fixture({ editorSocket: () => socket });
  await f.api.refreshBinding();
  let registrations = f.calls.filter(c => c.route === 'editor');
  assert.deepEqual(registrations[0].body, { socketPath: socket, workspaceFolders: ['/project'], explicit: false });
  assert.equal(f.calls.filter(c => c.exe).length, 0);
  socket = '/run/user/42/vscode-ipc-reloaded.sock';
  await f.api.refreshBinding();
  await f.api.show();
  registrations = f.calls.filter(c => c.route === 'editor');
  assert.equal(registrations[1].body.socketPath, socket);
  assert.equal(registrations.at(-1).body.explicit, true);
  assert.equal(f.calls.filter(c => c.exe).length, 1);
});

test('background registration is quiet without a unique bridge and never binds untrusted/other-language editors', async () => {
  let picks = 0;
  const f = fixture({ editorSocket: () => '/run/user/42/vscode-ipc-first.sock',
    candidates: async () => ['/project/one.json', '/project/two.json'] });
  f.vscode.window.showQuickPick = async () => { picks++; };
  await f.api.refreshBinding();
  assert.equal(picks, 0);
  assert.equal(f.calls.filter(c => c.route === 'editor').length, 0);
  f.calls.length = 0;
  f.vscode.workspace.isTrusted = false;
  await f.api.refreshBinding();
  f.vscode.workspace.isTrusted = true; f.document.languageId = 'javascript';
  await f.api.refreshBinding();
  assert.equal(f.calls.length, 0);
});

test('metadata/focus listeners renew binding after bridge startup and stop on disposal', async () => {
  const f = fixture({ editorSocket: () => '/run/user/42/vscode-ipc-first.sock' });
  f.api.startBinding();
  f.events.metadataCreate(); f.events.metadataChange(); f.events.active(); f.events.focus({ focused: true });
  await new Promise(resolve => setTimeout(resolve, 260));
  assert.equal(f.calls.filter(c => c.route === 'editor').length, 1, 'Events are debounced');
  for (const subscription of f.context.subscriptions) subscription.dispose();
  const count = f.calls.length;
  await f.api.refreshBinding();
  assert.equal(f.calls.length, count);
});

test('registration failure does not break forward search', async () => {
  const f = fixture({ editorSocket: () => '/run/user/42/vscode-ipc-first.sock',
    request: async (_meta, route) => {
      if (route === 'editor') throw Error('Unknown bridge request');
      return route === 'status' ? { forwardSearch: true, revision: 1, mappingReady: true } : f.target;
    } });
  await f.api.show();
  assert.equal(f.calls.filter(c => c.exe).length, 1);
  assert.deepEqual(f.warnings, []);
});

test('editor context-menu Uri uses the active cursor without treating it as a stale link', async () => {
  const f = fixture();
  await f.api.show(f.document.uri);
  assert.deepEqual(f.warnings, []);
  assert.equal(f.calls.find(c => c.route === 'forward').body.column, 6);
  assert.equal(f.calls.filter(c => c.exe).length, 1);
});

test('a PDF revision change before launch prevents a stale jump', async () => {
  let statuses = 0;
  const f = fixture({ request: async (_meta, route) => {
    if (route === 'status') return { forwardSearch: true, revision: ++statuses, mappingReady: true };
    return f.target;
  } });
  await f.api.show();
  assert.equal(f.calls.filter(c => c.exe).length, 0);
  assert.match(f.warnings[0], /document changed before/);
});

for (const kind of ['dirty', 'stale', 'invalid', 'untrusted', 'other-language', 'non-wsl'])
  test(`${kind} click does not touch the bridge or launch a viewer`, async () => {
    const f = fixture();
    if (kind === 'dirty') f.document.isDirty = true;
    if (kind === 'untrusted') f.vscode.workspace.isTrusted = false;
    if (kind === 'other-language') f.document.languageId = 'javascript';
    if (kind === 'non-wsl') f.vscode.env.remoteName = undefined;
    await f.api.show(f.document.uri.toString(), kind === 'stale' ? 0 : 1, 0, kind === 'invalid' ? 1000 : 5);
    assert.equal(f.calls.length, 0);
    assert.equal(f.warnings.length, 1);
  });

test('an edit during lookup prevents opening stale coordinates', async () => {
  const f = fixture({ request: async (_meta, route) => {
    if (route === 'status') return { forwardSearch: true };
    f.document.version++; return f.target;
  } });
  await f.api.show();
  assert.equal(f.calls.filter(c => c.exe).length, 0);
  assert.match(f.warnings[0], /source changed/);
});

test('rapid clicks cannot open an older result after the newer one', async () => {
  let firstResolve, count = 0;
  const f = fixture({ request: async (_meta, route) => {
    if (route === 'status') return { forwardSearch: true, revision: 1, mappingReady: true };
    if (++count === 1) return new Promise(resolve => { firstResolve = resolve; });
    return { ...f.target, record: 200 };
  } });
  const first = f.api.show();
  while (!firstResolve) await new Promise(setImmediate);
  await f.api.show();
  firstResolve({ ...f.target, record: 100 }); await first;
  assert.equal(f.calls.filter(c => c.exe).length, 1);
  assert.equal(f.calls.find(c => c.exe).target.record, 200);
});

test('Sumatra arguments handle UNC paths and reject malformed targets without a shell', () => {
  const { target } = fixture();
  target.pdf = '\\\\wsl.localhost\\Ubuntu\\project space\\résumé.pdf';
  assert.deepEqual(core.sumatraArguments(target), ['-reuse-instance', '-forward-search', target.source, '123', target.pdf]);
  assert.throws(() => core.sumatraArguments({ ...target, record: -1 }));
  assert.throws(() => core.sumatraArguments({ ...target, pdf: '-evil.pdf' }));
  assert.equal(core.linuxExecutable('C:\\Program Files\\SumatraPDF\\SumatraPDF.exe'), '/mnt/c/Program Files/SumatraPDF/SumatraPDF.exe');
});

test('bridge requests stay on loopback, authenticate and refuse redirects', async t => {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    seen.push({ auth: req.headers.authorization, body });
    if (req.url === '/redirect') { res.writeHead(302, { Location: 'https://example.invalid/' }); res.end(); }
    else { res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const metadata = { port: server.address().port, token: 'test-token', host: 'example.invalid' };
  assert.deepEqual(await core.request(metadata, 'forward', { line: 1 }), { ok: true });
  assert.equal(seen[0].auth, 'Bearer test-token');
  await assert.rejects(core.request(metadata, 'redirect'));
});

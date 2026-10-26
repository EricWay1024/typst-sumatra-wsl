const path = require('node:path');
const core = require('./core.cjs');
const command = 'typstSumatra.showInPdf';

function createExtension(vscode, context, dependencies = {}) {
  const services = { ...core, editorSocket: () => process.env.VSCODE_IPC_HOOK_CLI, ...dependencies };
  const output = vscode.window.createOutputChannel('Typst / Sumatra');
  context.subscriptions.push(output);
  const chosen = new Map();
  let executable, serial = 0, previous;
  const rootFor = document => vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath || path.dirname(document.uri.fsPath);
  const selectionKey = document => `selectedPdf:${rootFor(document)}`;
  const enabled = document => vscode.env.remoteName === 'wsl' && vscode.workspace.isTrusted && document.languageId === 'typst' &&
    document.uri.scheme === 'file' && vscode.workspace.getConfiguration('typstSumatra', document.uri).get('ctrlClick', true);

  // VS Code underlines every DocumentLink, even when Ctrl is not pressed.
  // A local editor decoration removes that visual noise without disabling links
  // or changing global CSS/settings. One range avoids per-word decoration cost.
  const plainLinks = vscode.window.createTextEditorDecorationType({ textDecoration: 'none !important' });
  function refreshAppearance(document) {
    for (const editor of vscode.window.visibleTextEditors) {
      if (document && editor.document !== document) continue;
      const doc = editor.document;
      const end = doc.lineCount - 1;
      editor.setDecorations(plainLinks, enabled(doc)
        ? [new vscode.Range(0, 0, end, doc.lineAt(end).text.length)] : []);
    }
  }
  context.subscriptions.push(plainLinks,
    vscode.window.onDidChangeVisibleTextEditors(() => refreshAppearance()),
    vscode.workspace.onDidChangeTextDocument(event => refreshAppearance(event.document)));
  refreshAppearance();

  const links = {
    provideDocumentLinks(document, token) {
      if (!enabled(document)) return [];
      const result = [];
      for (const word of services.words(document.getText())) {
        if (token.isCancellationRequested) return [];
        const link = new vscode.DocumentLink(new vscode.Range(word.line, word.character, word.line, word.end));
        link.tooltip = 'Show in Sumatra';
        link.source = [document.uri.toString(), document.version, word.line, word.character];
        result.push(link);
      }
      return result;
    },
    resolveDocumentLink(link) {
      // Resolution can happen on hover. It must not talk to the bridge or open
      // the PDF; only executing this command after a click does either.
      link.target = vscode.Uri.parse(`command:${command}?${encodeURIComponent(JSON.stringify(link.source))}`);
      return link;
    },
  };

  async function bridgeFor(document, signal, interactive = true) {
    const source = document.uri.fsPath, root = rootFor(document), cacheKey = path.dirname(source);
    const explicit = context.workspaceState.get(selectionKey(document));
    const remembered = explicit || chosen.get(cacheKey);
    if (remembered) {
      try { return await services.loadMetadata(remembered, source); }
      catch (error) { if (explicit) throw error; chosen.delete(cacheKey); }
    }
    let files = await services.candidates(source, root);
    if (!files.length) {
      const found = await vscode.workspace.findFiles(
        new vscode.RelativePattern(root, '**/.*.typst-sync.json'), '**/{.git,node_modules,scratch,.r2scratch,build}/**', 50);
      files = found.map(uri => uri.fsPath);
    }
    const active = (await Promise.all(files.map(async file => {
      try {
        const metadata = await services.loadMetadata(file, source);
        const status = await services.request(metadata, 'status', undefined, { signal, timeout: 1200 });
        return status.forwardSearch ? metadata : null;
      } catch { return null; }
    }))).filter(Boolean);
    if (!active.length) throw Error('No forward-search bridge found. Start the updated typst-sumatra watcher, or run “Typst/Sumatra: Select PDF”.');
    let selected = active.find(item => item.input === source);
    if (!selected && active.length === 1) selected = active[0];
    if (!selected && !interactive) return;
    if (!selected) {
      const pick = await vscode.window.showQuickPick(active.map(metadata => ({
        label: path.basename(metadata.pdf), description: metadata.pdf, metadata,
      })), { placeHolder: 'Which PDF should this Typst project jump to?' });
      selected = pick?.metadata;
    }
    if (selected) chosen.set(cacheKey, selected.metadataFile);
    return selected;
  }

  async function registerEditor(metadata, explicit, signal) {
    const socketPath = services.editorSocket();
    const workspaceFolders = (vscode.workspace.workspaceFolders || [])
      .filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath);
    if (!socketPath || !workspaceFolders.length || !vscode.workspace.isTrusted || vscode.env.remoteName !== 'wsl') return;
    try {
      await services.request(metadata, 'editor', { socketPath, workspaceFolders, explicit }, { signal, timeout: 1500 });
    } catch (error) {
      // Registration is an optional inverse-search optimization, not a reason
      // to break forward search against an older or temporarily unavailable bridge.
      if (!signal?.aborted) output.appendLine(`Editor registration unavailable: ${error.message}`);
    }
  }

  let bindingTimer, bindingController, bindingDisposed = false;
  async function refreshBinding() {
    bindingController?.abort();
    const controller = bindingController = new AbortController();
    const document = vscode.window.activeTextEditor?.document;
    if (bindingDisposed || !services.editorSocket() || !document || document.languageId !== 'typst' ||
        document.uri.scheme !== 'file' || !vscode.workspace.isTrusted || vscode.env.remoteName !== 'wsl') return;
    try {
      const metadata = await bridgeFor(document, controller.signal, false);
      if (metadata && !bindingDisposed && !controller.signal.aborted && vscode.window.activeTextEditor?.document === document)
        await registerEditor(metadata, false, controller.signal);
    } catch { /* No running/unique bridge yet: retry on metadata creation or editor focus. */ }
  }
  function startBinding() {
    const schedule = () => {
      clearTimeout(bindingTimer);
      bindingTimer = setTimeout(() => { void refreshBinding(); }, 200);
      bindingTimer.unref?.();
    };
    const watcher = vscode.workspace.createFileSystemWatcher('**/.*.typst-sync.json');
    context.subscriptions.push(watcher, watcher.onDidCreate(schedule), watcher.onDidChange(schedule),
      vscode.window.onDidChangeActiveTextEditor(schedule),
      vscode.window.onDidChangeWindowState(state => { if (state.focused) schedule(); }),
      { dispose() { bindingDisposed = true; clearTimeout(bindingTimer); bindingController?.abort(); } });
    schedule();
  }

  async function show(uriString, version, line, character) {
    const ticket = ++serial;
    previous?.abort();
    const controller = previous = new AbortController();
    try {
      const editor = vscode.window.activeTextEditor;
      const document = editor?.document;
      if (!document || vscode.env.remoteName !== 'wsl' || document.languageId !== 'typst' || document.uri.scheme !== 'file' || !vscode.workspace.isTrusted)
        throw Error('Forward search is available only for trusted, local Typst files in WSL');
      // Editor context menus pass the document Uri, while document links pass
      // the explicit string/version/position tuple. The palette passes nothing.
      if (uriString && typeof uriString !== 'string' && uriString.toString() === document.uri.toString()) uriString = undefined;
      if (uriString !== undefined) {
        if (uriString !== document.uri.toString() || version !== document.version)
          throw Error('This link is out of date; click the updated text again');
      } else {
        version = document.version;
        ({ line, character } = editor.selection.active);
      }
      if (!Number.isInteger(line) || line < 0 || line >= document.lineCount ||
          !Number.isInteger(character) || character < 0 || character > document.lineAt(line).text.length)
        throw Error('Invalid source location');
      if (document.isDirty) throw Error('Save this Typst file first; Sumatra shows the last compiled PDF');
      const sourceHash = services.hash(document.getText());
      const metadata = await bridgeFor(document, controller.signal);
      if (!metadata || ticket !== serial) return;
      if (metadata.version < 4) throw Error('Update the Linux bridge and restart its watcher to enable forward search');
      await registerEditor(metadata, true, controller.signal);
      if (ticket !== serial) return;
      const target = await services.request(metadata, 'forward', {
        filepath: document.uri.fsPath, line: line + 1, column: character + 1, sourceHash,
      }, { signal: controller.signal });
      if (ticket !== serial) return;
      if (document.version !== version || document.isDirty) throw Error('The source changed during lookup; save and click again');
      executable ||= await services.findSumatra(vscode.workspace.getConfiguration('typstSumatra').get('sumatraPath', ''));
      const status = await services.request(metadata, 'status', undefined, { signal: controller.signal, timeout: 1500 });
      if (ticket !== serial || vscode.window.activeTextEditor?.document !== document) return;
      if (document.version !== version || document.isDirty || !status.mappingReady || status.revision !== target.revision)
        throw Error('The document changed before the jump; click again after compilation');
      await services.launchSumatra(executable, target);
      output.appendLine(`Forward search sent to Sumatra: page ${target.page}, ${target.accuracy}-level match.`);
    } catch (error) {
      if (ticket !== serial || controller.signal.aborted) return;
      const message = error.message === 'fetch failed' ? 'Bridge unavailable. Start its watcher and click again.' : error.message;
      output.appendLine(message);
      vscode.window.showWarningMessage(`Typst/Sumatra: ${message}`);
    }
  }

  async function selectPdf() {
    const document = vscode.window.activeTextEditor?.document;
    if (!document || document.languageId !== 'typst' || !vscode.workspace.isTrusted) return;
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false,
      defaultUri: vscode.Uri.file(rootFor(document)), filters: { PDF: ['pdf'] }, openLabel: 'Use this PDF' });
    if (!picked?.length) return;
    try {
      const file = services.metadataPath(picked[0].fsPath);
      const metadata = await services.loadMetadata(file, document.uri.fsPath);
      await context.workspaceState.update(selectionKey(document), file);
      chosen.set(path.dirname(document.uri.fsPath), file);
      await registerEditor(metadata, true);
      vscode.window.showInformationMessage('Typst/Sumatra: PDF selected. Ctrl+click Typst text to jump.');
    } catch (error) { vscode.window.showWarningMessage(`Typst/Sumatra: ${error.message}`); }
  }

  const changed = new vscode.EventEmitter();
  links.onDidChangeDocumentLinks = changed.event;
  context.subscriptions.push(changed, vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('typstSumatra')) {
      executable = undefined; refreshAppearance(); changed.fire();
    }
  }));
  context.subscriptions.push({ dispose() { previous?.abort(); } });
  return { links, show, selectPdf, output, startBinding, refreshBinding };
}

function activate(context) {
  const vscode = require('vscode');
  const api = createExtension(vscode, context);
  context.subscriptions.push(
    vscode.languages.registerDocumentLinkProvider({ language: 'typst', scheme: 'file', pattern: '**/*.typ' }, api.links),
    vscode.commands.registerCommand(command, api.show),
    vscode.commands.registerCommand('typstSumatra.selectPdf', api.selectPdf),
  );
  api.startBinding();
  api.output.appendLine('Typst-only PDF links registered. Ctrl+click follows PDF links; F12 remains Go to Definition.');
  return api;
}
module.exports = { activate, createExtension };

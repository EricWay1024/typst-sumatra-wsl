# typst-sumatra-wsl

### Your PDF has a return address.

[![Built entirely by Codex](https://img.shields.io/badge/built_entirely_by-OpenAI_Codex-111827)](https://openai.com/codex/)
[![Checks](https://github.com/EricWay1024/typst-sumatra-wsl/actions/workflows/check.yml/badge.svg)](https://github.com/EricWay1024/typst-sumatra-wsl/actions/workflows/check.yml)

**Double-click your PDF → Typst source. Ctrl+click Typst source → PDF.**
SumatraPDF and VS Code, now on speaking terms in both directions.
Windows on one side. WSL on the other. Your train of thought, ideally, still intact.

> **This entire project was built by OpenAI Codex.**
> The architecture, bridge, native Windows launcher, performance investigation,
> fixes, tests, benchmarks, installer, CI, and this README. All Codex.
> The human supplied the problem, the feedback, and the entirely reasonable
> expectation that finding a line of text should not become a second research project.

[Get started](#get-started) · [Show me the numbers](#numbers-with-a-denominator) · [Under the hood](#under-the-hood) · [Meet the team](#meet-the-entire-engineering-department)

## We are disrupting “where did I write that?”

You write Typst in VS Code through WSL. You read the PDF in SumatraPDF on Windows.
You spot a typo. You would like to fix the typo, not conduct a cross-platform
archaeological expedition.

This bridge makes that double-click take you back to the source file, line and
column. That direction needs no extra VS Code extension. Add the small bundled
extension for **Ctrl+click back to the PDF**, in Typst files only. F12 still goes
to definitions; other languages keep their normal behaviour.

No hosted service. No account to create. We have pivoted to bidirectional.

**AI-built. Not AI-in-the-click-path.** Codex wrote the software; using it does
not call a model or upload your document. The bridge resolves jumps locally.
There is no token budget for correcting a comma.

Our total addressable market is everyone who has ever lost their place in a PDF.
Our supported addressable market is considerably more specific. We call this focus.

## Fewer processes. More progress.

The earlier click path looked like this:

```text
Sumatra → C# → PowerShell → wsl.exe → Bash → Node → HTTP → VS Code CLI
```

A remarkable amount of onboarding for one cursor movement.

The fast path now talks to things that are already running:

```text
Sumatra → native C# launcher → local bridge → running VS Code window
                                  │
                                  └─ resolve PDF position to Typst source
```

- **Direct delivery.** Authenticated loopback HTTP, then VS Code's existing local
  IPC. No fresh `Code.exe`, PowerShell, `wsl.exe`, Bash or Node process on the fast path.
- **Warm before you click.** After PDF compilation, the source mapper prepares in
  the background. Cached lookups leave the idle mapper asleep.
- **An actual fallback.** If editor IPC is unavailable or the target window is
  ambiguous, the normal VS Code CLI takes over. A stopped bridge can recover
  through WSL. We prefer a slower jump to an impressively fast nothing.
- **Your workflow stays yours.** Native Typst still makes the PDF. Sumatra still
  displays it. VS Code's Tinymist extension settings are left alone.

**Status: experimental.** This is a SyncTeX adapter, not native Typst SyncTeX
support. The marketing department is optimistic; the compatibility matrix is specific.

## Numbers with a denominator

On one Windows/WSL machine, **five alternating runs per launcher**, resolving the
same cached source record:

| Click preparation + source lookup | Median | Range |
| --- | ---: | ---: |
| Earlier PowerShell → WSL → Node chain | 2,800 ms | 2,289–2,985 ms |
| Native C# → HTTP client | 350 ms | 337–406 ms |

**About 8× faster for that measured stage.** Not “8× faster at everything.”
We have resisted the pitch-deck temptation to remove this sentence.

These are inverse-search launcher timings, not forward-search benchmarks.
Both launchers were started by a Windows parent from the same WSL directory.
`-PrintCommand` excluded the final VS Code CLI launch and editor update. These
measurements also **predate the direct editor-IPC path**: they do not quantify its
additional saving. Reproduce this comparison with [`windows/benchmark.ps1`](windows/benchmark.ps1).

Codex also found a less glamorous bottleneck: a mismatched log-message name made
negative source lookups wait **three seconds**, then discard the warmed mapper,
instead of trying nearby text. That is fixed and covered by a real-compiler
regression test. Sometimes the breakthrough is reading what the program actually said.

Cold compilation, recent saves and resource pressure can still cause delays.
We are optimising a jump, not repealing causality.

## Meet the entire engineering department

**Codex. That's the engineering department.**

This is not “AI-assisted” in the sense of accepting an autocomplete suggestion.
Codex built the complete bridge project end to end, under human direction:

| Department | Team |
| --- | --- |
| Architecture and implementation | Codex |
| Windows argument quoting and other character-building experiences | Codex |
| Profiling, optimisation and debugging | Codex |
| Tests, benchmarks, packaging and CI | Codex |
| Documentation and this slightly overfunded-sounding README | Also Codex |
| Product direction and “can it be faster?” | The human |

Including the bugs. Including the fixes. Full-stack ownership.

This is an independent project, not an official OpenAI product. And Codex did
**not** invent Typst, Tinymist, SumatraPDF, VS Code, Node.js or Poppler. This bridge
stands on their work; the attribution above is to the bridge project itself.

## Get started

### 0. The stack. Yes, the versions matter.

| Component | Tested version / requirement |
| --- | --- |
| Native Typst | **0.14.2**, at `~/.cargo/bin/typst` |
| Standalone Tinymist mapper | **0.14.20**, embedding Typst 0.14.2 |
| Node.js in WSL | **22+**, with built-in `WebSocket` support |
| Linux tools | Bash, Python 3, `pdftotext` from `poppler-utils` |
| Windows | SumatraPDF, VS Code with Remote - WSL, .NET Framework C# compiler |

The standalone mapper is separate from the VS Code Tinymist extension; the
extension can have a different version. **Do not swap arbitrary compiler/mapper
versions.** Their layout and source-position protocol must agree.

The tested viewer was SumatraPDF 3.5.x. The build helper assumes Windows is mounted
at `/mnt/c`; WSL localhost forwarding must work for the fast path. Third-party
binaries and document contents are not bundled.

### 1. Install the Linux side

Inside WSL:

```bash
git clone https://github.com/EricWay1024/typst-sumatra-wsl.git
cd typst-sumatra-wsl
bash install.sh
```

This installs `~/bin/typst-sumatra` and copies five library files to
`~/.local/lib/typst-sumatra/`. It does not replace the mapper binary or restart
existing watchers. Add `~/bin` to your `PATH`, or use the full path below.

Install [Typst 0.14.2](https://github.com/typst/typst/releases/tag/v0.14.2) at
`~/.cargo/bin/typst`, and the matching Linux binary from
[Tinymist v0.14.20](https://github.com/Myriad-Dreamin/tinymist/releases/tag/v0.14.20) at:

```text
~/.local/lib/typst-sumatra/bin/tinymist-0.14.20
```

Choose the correct Linux architecture, verify the upstream checksum and make the
binary executable. Both binaries' `--version` output should identify Typst 0.14.2.
Install `poppler-utils` if `pdftotext` is missing.

### 2. Install the Windows side

Still in the cloned repository:

```bash
mkdir -p scratch
export TYPST_SUMATRA_SCRATCH="$PWD/scratch"
bash windows/build.sh
python3 -B test-windows.py "$TYPST_SUMATRA_SCRATCH/open-in-vscode.exe"
```

Copy `scratch/open-in-vscode.exe` to a persistent Windows location, for example
`%LOCALAPPDATA%\SumatraPDF\open-in-vscode.exe`. Back up the old executable when upgrading.

In SumatraPDF's **Settings → Advanced Options**, add these entries, replacing
`<WindowsUser>` with your Windows account name:

```text
EnableTeXEnhancements = true
InverseSearchCmdLine = "C:\Users\<WindowsUser>\AppData\Local\SumatraPDF\open-in-vscode.exe" "%f" %l %c
```

The fallback launcher defaults to VS Code at
`%LOCALAPPDATA%\Programs\Microsoft VS Code`. For a different installation, set the
Windows environment variable `TYPST_SUMATRA_CODE_ROOT` to the directory containing
`Code.exe` and `bin/code.cmd`. The launcher discovers the versioned CLI entry point
from `code.cmd`; no VS Code version hash is hardcoded.

### 3. Achieve product–cursor fit

Inside your document project:

```bash
cd /path/to/document-project
mkdir -p scratch
~/bin/typst-sumatra watch --root . main.typ main.pdf
```

Open `main.pdf` in Windows SumatraPDF. `wslpath -w main.pdf` gives its Windows UNC
path. **Double-click text. Go back to writing.** That is the entire product demo.

The bridge owns the native PDF watcher. **Do not run another `typst watch` writing
the same PDF.** For a detached watcher, use this instead:

```bash
~/bin/typst-sumatra ensure --root . main.typ main.pdf
```

Ignore generated files in your document repository:

```gitignore
/scratch/
*.pdf
*.synctex
*.synctex.gz
*.typst-sync.json
```

### 4. Book the return trip: Ctrl+click → PDF

For forward search, install the bundled extension **in WSL**, not the Windows
extension host. From this repository in a VS Code WSL terminal:

```bash
export TYPST_SUMATRA_SCRATCH="$PWD/scratch"
python3 -B vscode-extension/package.py
code --install-extension "$TYPST_SUMATRA_SCRATCH/typst-sumatra-wsl-0.1.0.vsix"
```

The package is built locally with Python's standard library; no npm downloads or
Marketplace account are required. If VS Code requests a window reload after an
extension update, reload once to activate the new version. When upgrading an existing bridge, rerun
`bash install.sh` and stop/restart its watcher too. An older running watcher will
not gain forward search merely because its files changed on disk.

**Save your `.typ` file, then hold Ctrl and click a word.** The tooltip says
“Show in Sumatra”. The extension finds a running bridge via its metadata, reuses
the same mapper, and asks Sumatra to highlight the corresponding SyncTeX word.
It does not modify or automatically save your document, replace Tinymist, or add
another compiler. There is also a **Show in Sumatra** editor context-menu command.

If several PDFs are available, choose one when prompted. For a nonstandard output
location, run **Typst/Sumatra: Select PDF** from the command palette. Sumatra is
automatically found in its per-user or Program Files installation; set
`typstSumatra.sumatraPath` in user settings if needed.

With VS Code's default mouse settings, links use Ctrl+click. If you have set
`editor.multiCursorModifier` to `ctrlCmd`, VS Code uses Alt+click for links
instead; this extension does not change that global setting. Set
`typstSumatra.ctrlClick` to `false` to disable PDF links while keeping the command.

## The fine print, in normal-sized type

- **Not every PDF glyph has an exact source span.** Generated text and whitespace
  may resolve approximately to nearby source text. In the other direction,
  comments and non-rendered code may have no PDF location. The mapper supplies
  span-level anchors; matching words are refined using inverse queries (at most
  32 candidate probes), otherwise the result is explicitly a span-level fallback.
  Repeated content uses the first verified match, not an occurrence chooser.
- **Saved sources only.** Forward search checks a content hash and PDF revision,
  refuses unsaved/stale clicks and cancels superseded requests. Hovering a PDF
  link never opens the viewer. The extension requires a trusted WSL workspace.
- **Prewarming is not incremental mapper reuse.** Native recompilation still
  restarts the mapper and invalidates cached source positions. Clicking right
  after a save can require waiting; a lookup interrupted by an update is rejected
  rather than returning stale line numbers.
- **Window selection is deliberate.** A watcher started inside the intended
  VS Code terminal can inherit `VSCODE_IPC_HOOK_CLI`. Otherwise, the bridge uses a
  unique active, same-user CLI socket. Missing, ambiguous or unresponsive sockets
  fall back to the CLI. A stale explicit binding is not redirected to another window.
- **Keep the capability token private.** The hidden `.typst-sync.json` metadata
  beside the PDF contains it. Do not publish that file, expose the loopback HTTP
  service to a network, or remove authentication. “Local-first” is not permission
  to bind to `0.0.0.0` and hope.
- **Scratch is persistent.** The helper uses `TYPST_SUMATRA_SCRATCH`, an existing
  `.r2scratch` beside the PDF, or an existing `scratch` under the project root, in
  that order. If none exists, it asks for an explicit directory. Logs and mapper
  snapshots live in `SCRATCH/typst-sumatra/`, never the OS temporary directory.

## Under the hood

<details>
<summary><strong>The architecture slide, without the gradient</strong></summary>

1. Native Typst compiles the PDF. `pdftotext` extracts word rectangles, which the
   bridge publishes as a coordinate-based SyncTeX file Sumatra can read.
2. After compilation, a separate, version-matched Tinymist process prewarms source
   lookup. It pauses after 800 ms of inactivity; a cache hit does not wake it.
3. Sumatra launches the native C# helper with the selected record. The helper reads
   metadata over the WSL UNC share and sends an authenticated loopback HTTP request.
4. The bridge resolves the source position. Nearby-text fallback uses a page-local
   index and a bounded top-eight selection. Negative replies are recognised
   immediately instead of waiting for the query timeout.
5. The bridge sends a goto request to the running editor's local IPC socket.
   The Windows helper first passes foreground permission to the running Code
   process. If IPC cannot be used, the helper invokes the ordinary VS Code CLI.
6. If the bridge itself has stopped, the helper can recover it through `wsl.exe`,
   finding the Linux helper under the default WSL user's `$HOME/bin`.

For the return trip, the Typst-only document-link provider creates a command
link for each non-whitespace word. Only a click sends `/forward` with the saved
file's hash and UTF-16 cursor coordinates. The bridge converts columns to the
pinned mapper's Unicode-scalar convention, requests source-to-document anchors,
and verifies candidate words through inverse lookup. Forward and inverse queries
share one serial queue because the mapper protocol has no request IDs.

The extension launches Sumatra with `-reuse-instance -forward-search`, using the
bridge metadata filename and the coordinate record as SyncTeX's source/line pair.
The real `.typ` path is **not** passed as a conventional SyncTeX source: the
adapter's map indexes PDF coordinates. `lastForward` and `timings.lastForwardMs`
on `/status` report lookup results/timing, not completed GUI updates.

The IPC format was checked against VS Code 1.143.1's
[`server.cli.ts`](https://github.com/microsoft/vscode/blob/e646868227c3e3a9e3f24277c8c7220be42c0be7/src/vs/server/node/server.cli.ts)
and [`extHostCLIServer.ts`](https://github.com/microsoft/vscode/blob/e646868227c3e3a9e3f24277c8c7220be42c0be7/src/vs/workbench/api/node/extHostCLIServer.ts).
It is an internal protocol, not a promised public API. Hence the fallback.

For the three-second bug: Tinymist 0.14.20 logs frame-location results as
`resolved WebviewResolveSpan: None`, not `resolved WebviewResolveFrameLoc: None`.
The previous matcher missed the negative reply. The regression test clicks an
empty margin, resolves nearby text and verifies the same warmed mapper survives.

</details>

<details>
<summary><strong>Due diligence: diagnostics and tests</strong></summary>

The authenticated `/status` endpoint reports map readiness, mapper state,
revision, warmup timing and cache hits. `editor.lastRequest` records `vscode-ipc`
or `cli-fallback`, handoff time and any fallback reason. **IPC acknowledgement
means the request was forwarded, not that the GUI has finished updating.**

Two native-launcher flags inspect the click path without opening the editor:

- `--resolve-only`: source file, line and column as UTF-8 JSON.
- `-PrintCommand`: the VS Code command that would be used.

From the cloned repository:

```bash
node --test test.mjs editor-ipc.test.mjs forward.test.mjs vscode-extension/test.cjs
mkdir -p scratch
export TYPST_SUMATRA_SCRATCH="$PWD/scratch"
node integration-test.mjs
node forward-integration-test.mjs  # Also requires the synctex command-line tool.
python3 -B test-windows.py "$TYPST_SUMATRA_SCRATCH/open-in-vscode.exe"
python3 -B test-forward-windows.py
```

The integration test uses a tiny standalone document, real compilers and isolated
persistent scratch. It covers prewarming, cache hits, authentication, line shifts,
rapid saves, negative source replies, editor IPC and fallback. Forward-search tests
cover imported sources, supplementary Unicode characters, actual SyncTeX forward
queries, cache invalidation after saving, and timeout recovery. Extension tests
cover Typst-only registration, hover safety, unsaved/stale buffers and rapid clicks;
a native Windows sentinel checks viewer arguments without opening a PDF.

Set `TYPST_SUMATRA_CLIENT` to the Linux path of the built Windows launcher to also
check Windows → real bridge → mock editor and stopped-bridge recovery. Recovery
requires the Linux helper to be installed.

Tests do not open VS Code or edit your document. Windows tests use a sentinel CLI
so a broken fast path cannot accidentally open the real editor. Unix-socket
fixtures live in the repository's `scratch/` directory to stay within the socket
pathname-length limit.

CI runs dependency-free JavaScript tests and syntax checks, and compiles the C#
launcher on Windows. Actual WSL/Sumatra interaction requires the local tests.
AI authorship is not a substitute for those checks. Codex wrote those too.

</details>

---

**Built entirely by Codex. Now with a return ticket.**

Our exit strategy is `--goto`.

# Typst ↔ SumatraPDF ↔ VS Code (WSL)

[![Checks](https://github.com/EricWay1024/typst-sumatra-wsl/actions/workflows/check.yml/badge.svg)](https://github.com/EricWay1024/typst-sumatra-wsl/actions/workflows/check.yml)

Double-click text in **SumatraPDF on Windows** to jump to its **Typst source in
VS Code running through WSL**.

This is an experimental inverse-search bridge, not native Typst SyncTeX support.
It keeps the native Typst compiler responsible for the PDF and uses a separate,
version-matched Tinymist process to resolve PDF coordinates to source positions.
It does not change VS Code's Tinymist extension settings.

## How it works

```text
SumatraPDF -> native C# launcher -> authenticated loopback HTTP -> source position
                               -> running VS Code's local IPC -> editor
                               -> VS Code CLI (fallback only)
```

- PDF word rectangles are extracted with `pdftotext` and published as a
  coordinate-based SyncTeX file that Sumatra can read.
- The native launcher requests the already-running WSL service directly. The
  service hands the position to the running editor using VS Code's remote-CLI
  IPC protocol. The fast path starts neither `Code.exe` nor PowerShell, `wsl.exe`,
  Bash or Node. No additional editor extension is installed.
- An explicit `VSCODE_IPC_HOOK_CLI` inherited from a VS Code terminal selects that
  window. Otherwise, the service uses a unique active, same-user CLI socket.
  Missing, ambiguous or unresponsive sockets fall back to the existing VS Code
  CLI. Stale explicit bindings are never silently redirected to another window.
- The Windows helper passes foreground permission to the running Code process
  before requesting a jump, so IPC does not depend on launching another Code
  process to bring the editor forward.
- After PDF compilation, the source mapper is prewarmed in the background. It is
  paused after 800 ms of inactivity. A cached lookup does not wake it.
- Nearby-word fallback uses a page-local index and a bounded top-eight selection.
  Negative mapper replies are recognised immediately, rather than wasting the
  three-second query timeout before failing to try nearby text.
- PDF updates invalidate cached source locations. Results interrupted by an update
  are rejected rather than returned with stale line numbers.
- A stopped bridge can be restarted through `wsl.exe`; the recovery path finds
  the helper under the default WSL user's `$HOME/bin`.

**Prewarming is not incremental mapper reuse.** The separate mapper is still
restarted when the native compiler rebuilds, so it cannot silently query an old
compiled document. Clicking immediately after saving can still require waiting.
Generated text or whitespace may resolve approximately to nearby source text.

## Requirements

The currently tested compiler pair is:

| Component | Version / location |
| --- | --- |
| Native Typst | **0.14.2**, at `~/.cargo/bin/typst` |
| Standalone Tinymist mapper | **0.14.20**, embedding Typst 0.14.2 |
| Node.js | Built-in `WebSocket` support; Node 22+ |
| Linux tools | Bash, Python 3, `pdftotext` from `poppler-utils` |
| Windows tools | SumatraPDF, VS Code with Remote - WSL, .NET Framework C# compiler |

The mapper is independent of the VS Code Tinymist extension; the extension can
have a different version. Do not substitute arbitrary mapper/compiler versions:
their layout and source-position protocol must agree.

The fallback launcher defaults to a **per-user VS Code installation** at
`%LOCALAPPDATA%\Programs\Microsoft VS Code`. For a different installation, set the
Windows environment variable `TYPST_SUMATRA_CODE_ROOT` to the directory containing
`Code.exe` and `bin/code.cmd`. The build helper assumes Windows is
mounted at `/mnt/c`. WSL localhost forwarding must be available for the fast path.
The tested PDF viewer was SumatraPDF 3.5.x.

Third-party binaries and document contents are not included in this repository.

## Install

### 1. Linux helper, inside WSL

```bash
git clone https://github.com/EricWay1024/typst-sumatra-wsl.git
cd typst-sumatra-wsl
bash install.sh
```

This installs `~/bin/typst-sumatra` and copies four library files into
`~/.local/lib/typst-sumatra/`. It leaves the mapper binary and existing watchers
alone. Add `~/bin` to your `PATH`, or use the full helper path as below.

Install [Typst 0.14.2](https://github.com/typst/typst/releases/tag/v0.14.2) at
`~/.cargo/bin/typst`. Install the matching Linux binary from
[Tinymist v0.14.20](https://github.com/Myriad-Dreamin/tinymist/releases/tag/v0.14.20)
at:

```text
~/.local/lib/typst-sumatra/bin/tinymist-0.14.20
```

Choose the appropriate Linux architecture, verify the upstream checksum and make
the binary executable. Both `typst --version` and the mapper's `--version` output
should identify Typst 0.14.2. Install `poppler-utils` if `pdftotext` is missing.

### 2. Windows inverse-search launcher

Still in the cloned repository, build into persistent scratch:

```bash
mkdir -p scratch
export TYPST_SUMATRA_SCRATCH="$PWD/scratch"
bash windows/build.sh
python3 -B test-windows.py "$TYPST_SUMATRA_SCRATCH/open-in-vscode.exe"
```

Copy `scratch/open-in-vscode.exe` to a persistent Windows location, for example
`%LOCALAPPDATA%\SumatraPDF\open-in-vscode.exe`. If upgrading, keep a backup of the
previous executable first.

In SumatraPDF's **Settings → Advanced Options**, set these entries, replacing
`<WindowsUser>` with the actual Windows account name:

```text
EnableTeXEnhancements = true
InverseSearchCmdLine = "C:\Users\<WindowsUser>\AppData\Local\SumatraPDF\open-in-vscode.exe" "%f" %l %c
```

The native launcher discovers VS Code's versioned CLI location from its installed
`code.cmd`; no VS Code version hash is hardcoded.

## Use

Inside your document project:

```bash
cd /path/to/document-project
mkdir -p scratch
~/bin/typst-sumatra watch --root . main.typ main.pdf
```

Open `main.pdf` in Windows SumatraPDF. `wslpath -w main.pdf` gives its Windows UNC
path. Double-click text in the PDF to jump to the source in VS Code.

Do not run another `typst watch` writing the same PDF. The bridge already owns a
native watcher. To start a detached watcher instead:

```bash
~/bin/typst-sumatra ensure --root . main.typ main.pdf
```

Scratch selection is: `TYPST_SUMATRA_SCRATCH`, an existing `.r2scratch` beside the
PDF, or an existing `scratch` under the project root. If none exists, the helper
asks for an explicit directory. It never uses the OS temporary directory.
Generated logs and mapper snapshots stay in `SCRATCH/typst-sumatra/`.

Ignore generated files in your document repository:

```gitignore
/scratch/
*.pdf
*.synctex
*.synctex.gz
*.typst-sync.json
```

The hidden metadata file next to the PDF contains a local capability token. Do
not publish it. The HTTP bridge binds only to `127.0.0.1`; do not expose it to a
network or remove its authentication.

## Diagnostics and tests

The authenticated `/status` endpoint reports map readiness, mapper state, revision,
warmup timing and cache hits. `editor.lastRequest` reports `vscode-ipc` or
`cli-fallback`, the handoff time and any fallback reason. IPC acknowledgement
means the request was forwarded, **not** that the GUI has finished updating.
The native launcher provides two non-GUI modes:

- `--resolve-only`: output the source file, line and column as UTF-8 JSON.
- `-PrintCommand`: output the VS Code command without opening the editor.

```bash
node --test test.mjs editor-ipc.test.mjs
export TYPST_SUMATRA_SCRATCH="$PWD/scratch"
node integration-test.mjs
python3 -B test-windows.py "$TYPST_SUMATRA_SCRATCH/open-in-vscode.exe"
```

The integration test uses a tiny standalone document, real compilers and isolated
persistent scratch. It checks prewarming, cache hits, authentication, line shifts,
rapid saves, negative source replies, editor IPC and fallback. Set
`TYPST_SUMATRA_CLIENT` to the Linux path of the built Windows launcher to also test
Windows → real bridge → mock editor and recovery of a stopped bridge; recovery
requires the Linux helper to be installed. Tests do not open VS Code or edit your
document. The Windows tests use a sentinel CLI so a failed fast-path test cannot
accidentally open the real editor. Unix-socket fixtures use the repository's
`scratch/` directory to stay within the Unix socket pathname-length limit.

CI runs dependency-free JavaScript tests and syntax checks, and compiles the C#
launcher on Windows. The actual WSL/Sumatra interaction requires the local tests.

## Performance measurement

On one Windows/WSL machine, five alternating runs per launcher against the same
cached source record gave:

| Click preparation and source lookup | Median | Range |
| --- | ---: | ---: |
| Previous PowerShell → WSL → Node launch chain | 2800 ms | 2289–2985 ms |
| Native C# → HTTP client | 350 ms | 337–406 ms |

This is about eight times faster **for the measured part of the path**, not an
end-to-end GUI latency claim. Both launchers were started by a Windows parent
from the same WSL directory; `-PrintCommand` excluded the final VS Code CLI launch
and editor selection update. These figures predate the direct editor-IPC path;
they do not measure its additional saving. `windows/benchmark.ps1` can compare
two builds in that way. Document compilation, prewarming and system resource
pressure can still cause delays, especially immediately after edits.

The IPC wire format was checked against VS Code 1.143.1's
[`server.cli.ts`](https://github.com/microsoft/vscode/blob/e646868227c3e3a9e3f24277c8c7220be42c0be7/src/vs/server/node/server.cli.ts)
and [`extHostCLIServer.ts`](https://github.com/microsoft/vscode/blob/e646868227c3e3a9e3f24277c8c7220be42c0be7/src/vs/workbench/api/node/extHostCLIServer.ts).
It is an internal protocol; the ordinary CLI remains the compatibility fallback.

A separate latency bug concerned negative mapper results: Tinymist 0.14.20 logs
frame-location results as `resolved WebviewResolveSpan: None`, not
`resolved WebviewResolveFrameLoc: None`. The previous matcher missed that reply,
waited three seconds and discarded the warmed mapper. The corrected matcher is
covered by a real-compiler test that clicks an empty margin, resolves nearby text
and verifies that the same mapper process survives. This approximate fallback is
not a claim that generated PDF text has an exact source span.

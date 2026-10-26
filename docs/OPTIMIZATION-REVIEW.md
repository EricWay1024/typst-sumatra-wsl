# Optimization review — 2026-10-26

Audited implementation: `e118935`. This review and its benchmark do **not** change
or redeploy the bridge or VS Code extension. No document contents or capability
tokens are included here.

## Priorities

### 1. Repair editor binding after window reloads

At inspection, the last recorded editor open used `cli-fallback` with
`ECONNREFUSED`: the watcher still held the IPC socket of an earlier VS Code
extension host. Reloading the editor can therefore defeat the direct-IPC
optimization while leaving inverse search operational through the CLI.

This is a lifecycle issue rather than an inner-loop algorithm issue, but it
should precede micro-optimization. The installed workspace extension could
explicitly register its current window with the authenticated bridge. Binding
must remain project/window-specific; do not silently pick an arbitrary socket
when several listeners exist. End-to-end savings from rebinding were **not**
measured in this audit.

Relevant code: `editorSocket()` in `editor-ipc.mjs`, and extension activation.

### 2. Stop superseded forward work at safe boundaries

The extension aborts its previous HTTP request. The bridge checks
`response.destroyed` before starting mapping, but `resolveForward()`'s later
`check()` checks only the PDF revision, readiness, deadline and saved source.
An already-running cancelled lookup can therefore continue probing candidates
and block newer work in the shared serial queue.

Check cancellation after mapper startup and between probes. Drain an already
sent mapper query before releasing the queue: its replies have no request IDs.
Abandoning that reply and immediately sending another query risks associating
it with the wrong click. Do not introduce parallel mapper queries as an
optimization. This finding is from control-flow inspection, not a latency test.

### 3. Parse a source position once, not on every guard check

`readForwardSource()` performs path confinement, file reading, hashing, two
whole-file line splits, token extraction, Unicode-column conversion and a stat.
`resolveForward()` calls it initially and repeats it through `check()`.

For a successful uncached request with one inverse verification probe, there
are **six calls**; with 32 probes there are **37 calls**. Cache hits still make
two calls. The immutable request's position/token does not need repeated parsing.
Separate initial parsing from subsequent path/content validation. Keep the full
hash and revision checks; replacing them with only size/mtime would weaken
stale-source detection.

The benchmark's validation-only prototype retains path confinement, a full
file read/hash and the stat. It omits repeated source-position/token parsing.
Concurrency/save-race behavior of an integrated implementation has not been
tested; final edit/revision guards must remain when implementing it.

### 4. Index normalized words lazily per page

`refineForward()` normalizes and scans all words on each indicated page, then
sorts matches. A per-page `normalized word → word records` index can reuse that
work across uncached lookups in one PDF revision. Preserve original insertion
order for equal-distance ties, and copy the indexed candidate array before
sorting it. Invalidate the index when the PDF revision changes.

Prefer lazy page indexes to eagerly indexing the entire document. In this
sample, an index cost about 0.117 ms per sampled page to build, so roughly two
uncached lookups on that page are needed to amortize it. Repeating an already
cached forward request does not help amortization: it bypasses refinement.
The absolute saving is small; it does not explain multi-second waits.

## Measurements and their limits

Node 25.6.1, one WSL machine, warm filesystem/CPU measurements. Each comparison
uses 11 alternating-order batches after warmup. Validation batches contain
30 calls, at one valid position per source file near its middle line.
These are **not** click-to-GUI timings.

| Source sample size | Lines | Existing validation, ms/call | Validation without re-parsing, ms/call |
| ---: | ---: | ---: | ---: |
| 70,002 bytes | 1,291 | 0.395 | 0.220 |
| 36,189 bytes | 674 | 0.205 | 0.114 |
| 8,896 bytes | 198 | 0.081 | 0.055 |

Candidate benchmark input: one 49-page, 33,927-word PDF map. Timed selection
covered 19 page/term cases across seven sampled pages, 10 repetitions per batch,
11 alternating batches. The baseline scans/normalizes then sorts; the prototype
uses an already-built page index then sorts. Both retain at most 32 candidates.

| Candidate preparation only | Median batch-average time per selection |
| --- | ---: |
| Existing scan/normalize/sort | 0.0778 ms |
| Pre-indexed lookup/sort, excluding index construction | 0.00085 ms |

The candidate order matched exactly in **57 comparisons**: those page/term cases
at three anchors per page. That is evidence for these inputs, not a completeness
test of a production index implementation. The source/PDF corpus is private and
is not distributed with the benchmark.

A separate, single live status observation reported native compilation at
**285 ms**, map publication lag at **1,230 ms**, and mapper warmup at **3,162 ms**.
These stages overlap; do not add them as though they were serial, or treat one
observation as a latency distribution. They indicate why sub-millisecond word
indexing is not the first remedy for a slow jump immediately after saving.

## Larger changes, not quick wins

- **Incremental mapper reuse:** currently every native compilation stops the
  mapper and throws away its compiler state. Reusing it could attack the larger
  warmup cost, but needs a reliable association between the mapper's compilation
  and the native PDF revision. A success notification alone is not enough: it
  might belong to an older build. Do not trade source-map freshness for speed.
- **Explicit negative forward replies:** Tinymist 0.14.20's
  [`resolve_source_loc`](https://github.com/Myriad-Dreamin/tinymist/blob/v0.14.20/crates/typst-preview/src/actor/render.rs#L293)
  returns without sending a jump when its result is empty. The bridge cannot
  distinguish that from a missing response, waits three seconds, then discards
  the untagged connection. A compatible mapper protocol change could avoid that
  wait and the next *uncached* lookup's restart. Do not cache timeouts as proven
  negative results, or simply shorten the timeout for legitimate slow queries.
- **Editor link generation:** it still rebuilds a link per word for a changed
  document. Visible-range or incremental generation might reduce editor work,
  but must preserve precise Ctrl+click coordinates across edits and split views.
  Editor-side generation/RPC/rendering costs were not profiled in this audit.

## Reproduce the CPU checks

```bash
mkdir -p scratch/optimization-review
node optimization-benchmark.mjs /path/to/points.json /path/to/source.typ \
  /path/to/another-source.typ > scratch/optimization-review/benchmark.json
```

`points.json` is an existing bridge snapshot under its persistent scratch
session. The benchmark reads inputs only, launches no compiler/editor/viewer,
and emits counts and timings rather than document text or filenames. A changed
source hash is an error, not a zero-valued timing. The prototypes are isolated
from production code.

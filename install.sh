#!/bin/bash
# Install the Linux helper, without replacing the compatible Tinymist binary.
set -euo pipefail
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$HOME/bin" "$HOME/.local/lib/typst-sumatra"
ln -sfn "$repo/bin/typst-sumatra" "$HOME/bin/typst-sumatra"
for name in editor-ipc.mjs typst-sumatra.mjs map-worker.mjs extract-boxes.py; do
  install -m 644 "$repo/$name" "$HOME/.local/lib/typst-sumatra/$name"
done
printf '%s\n' \
  'Installed ~/bin/typst-sumatra and the Linux bridge sources.' \
  'The Tinymist binary and any running watcher were not changed.' \
  'See README.md to build/install the Windows launcher and configure Sumatra.'

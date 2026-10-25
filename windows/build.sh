#!/bin/bash
# Build the native Windows launcher into explicitly chosen persistent scratch.
set -euo pipefail
: "${TYPST_SUMATRA_SCRATCH:?Set TYPST_SUMATRA_SCRATCH to persistent project scratch}"
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$TYPST_SUMATRA_SCRATCH"
output="$(realpath "$TYPST_SUMATRA_SCRATCH")/open-in-vscode.exe"
compiler=/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe
"$compiler" /nologo /target:winexe /optimize+ /reference:System.Web.Extensions.dll \
  "/out:$(wslpath -w "$output")" "$(wslpath -w "$here/OpenInVSCode.cs")"
chmod +x "$output"
printf 'Built %s\n' "$output"

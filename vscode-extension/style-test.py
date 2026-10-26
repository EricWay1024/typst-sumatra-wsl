#!/usr/bin/env python3
"""Optional Chromium check of link CSS; all browser artifacts stay in scratch.

Set TYPST_SUMATRA_CHROMIUM to a directly runnable Chromium binary (not a snap
wrapper). This tests rendering, not the full VS Code click integration.
"""
import json
import os
from pathlib import Path
import re
import subprocess

here = Path(__file__).resolve().parent
scratch = Path(os.environ.get('TYPST_SUMATRA_SCRATCH', here.parent / 'scratch')) / 'style'
scratch = scratch.resolve()
for folder in ['', 'tmp', 'cache', 'config', 'profile']:
    (scratch / folder).mkdir(parents=True, exist_ok=True)
style = re.search(r"textDecoration: '([^']+)'", (here / 'extension.cjs').read_text()).group(1)
# VS Code links.css and decoration service apply these rules to the same text
# spans. The generated decoration class is scoped to decorated editor ranges.
html = '''<!doctype html><meta charset="utf-8"><style>
.monaco-editor .plain-links { text-decoration: STYLE; }
.monaco-editor .detected-link, .monaco-editor .detected-link-active {
  text-decoration: underline; text-underline-position: under;
}
.monaco-editor .detected-link-active { cursor: pointer; color: blue !important; }
.monaco-editor .squiggly-error { background-image: linear-gradient(red, red); }
</style><div class="monaco-editor">
<span id="plain" class="detected-link plain-links">ordinary text</span>
<span id="active" class="detected-link-active plain-links">Ctrl-hover</span>
<span id="other" class="detected-link">another language</span>
<span id="diagnostic" class="detected-link plain-links squiggly-error">diagnostic</span>
</div><pre id="result"></pre><script>
const get = id => getComputedStyle(document.getElementById(id));
result.textContent = JSON.stringify({plain: get('plain').textDecorationLine,
  active: get('active').textDecorationLine, cursor: get('active').cursor,
  other: get('other').textDecorationLine, diagnostic: get('diagnostic').backgroundImage});
</script>'''.replace('STYLE', style)
page = scratch / 'style.html'
page.write_text(html)
env = dict(os.environ, TMPDIR=str(scratch / 'tmp'), XDG_CACHE_HOME=str(scratch / 'cache'),
           XDG_CONFIG_HOME=str(scratch / 'config'))
run = subprocess.run([os.environ['TYPST_SUMATRA_CHROMIUM'], '--headless', '--no-sandbox',
    '--disable-gpu', '--disable-dev-shm-usage', '--disable-background-networking', '--no-first-run',
    '--user-data-dir=' + str(scratch / 'profile'), '--dump-dom', page.as_uri()],
    env=env, capture_output=True, text=True, timeout=20)
(scratch / 'rendered.html').write_text(run.stdout)
(scratch / 'browser.log').write_text(run.stderr)
if run.returncode:
    raise RuntimeError(f'Chromium failed ({run.returncode}): {run.stderr}')
result = json.loads(re.search(r'<pre id="result">(.*?)</pre>', run.stdout).group(1))
assert result['plain'] == result['active'] == 'none', result
assert result['other'] == 'underline' and result['cursor'] == 'pointer', result
assert result['diagnostic'].startswith('linear-gradient'), result
print('PASS: no PDF-link underlines; pointer, other-language links and diagnostic background retained.')

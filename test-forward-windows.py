"""Test WSL -> native Windows forward-search argument delivery, without a GUI."""
import json
import os
from pathlib import Path
import subprocess
import time

repo = Path(__file__).resolve().parent
scratch = Path(os.environ['TYPST_SUMATRA_SCRATCH']).resolve()
scratch.mkdir(parents=True, exist_ok=True)
exe = scratch / 'mock sumatra.exe'
log = scratch / 'forward-arguments.json'
if log.exists():
    log.unlink()
winpath = lambda p: subprocess.check_output(['wslpath', '-w', str(p)], text=True).strip()
subprocess.run(['/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe', '/nologo',
                '/target:exe', '/reference:System.Web.Extensions.dll', '/out:' + winpath(exe),
                winpath(repo / 'windows' / 'MockSumatra.cs')], cwd='/mnt/c/Windows', check=True)
exe.chmod(0o755)
target = {'record': 2121784, 'source': r'\\wsl.localhost\Ubuntu\home\test\space α\.doc.typst-sync.json',
          'pdf': r'\\wsl.localhost\Ubuntu\home\test\space α\résumé.pdf'}
env = dict(os.environ, TYPST_SUMATRA_TEST_LOG=winpath(log))
env['WSLENV'] = env.get('WSLENV', '') + ':TYPST_SUMATRA_TEST_LOG'
script = "require('./vscode-extension/core.cjs').launchSumatra(process.argv[1], JSON.parse(process.argv[2])).catch(e=>{console.error(e);process.exit(1)})"
subprocess.run(['node', '-e', script, str(exe), json.dumps(target)], cwd=repo, env=env, check=True, timeout=15)
for _ in range(100):
    if log.exists():
        break
    time.sleep(.05)
actual = json.loads(log.read_text(encoding='utf-8-sig'))
assert actual == ['-reuse-instance', '-forward-search', target['source'], str(target['record']), target['pdf']], actual
print('PASS: native Windows receiver got exact forward-search arguments, including spaces and Unicode.')

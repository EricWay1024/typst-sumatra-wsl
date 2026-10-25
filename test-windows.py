"""Exercise the native Windows client without opening VS Code.

Usage: python3 -B test-windows.py /persistent/scratch/open-in-vscode.exe
Outputs stay beside the test executable, never in the OS temporary directory.
"""
import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import threading

exe = Path(sys.argv[1]).resolve()
work = exe.parent
winpath = lambda p: subprocess.check_output(['wslpath', '-w', str(p)], text=True).strip()
# Even a regression in the IPC fast path must not open the real editor.
code = work / 'mock-code'
(code / 'bin').mkdir(parents=True, exist_ok=True)
(code / 'bin' / 'code.cmd').write_text('"%~dp0..\\cli.js"\n')
(code / 'cli.js').write_text('// Mock CLI entry point.\n')
subprocess.run(['/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe', '/nologo',
                '/target:exe', '/out:' + winpath(code / 'Code.exe'),
                winpath(Path(__file__).resolve().parent / 'windows' / 'MockCode.cs')],
               cwd='/mnt/c/Windows', check=True, timeout=30)
env = dict(os.environ, TYPST_SUMATRA_CODE_ROOT=winpath(code))
env['WSLENV'] = env.get('WSLENV', '') + ':TYPST_SUMATRA_CODE_ROOT'
requests = []
accept_open = True


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        ok = (self.path == '/resolve'
              and self.headers.get('Authorization') == 'Bearer test-capability'
              and body['id'] == 101)
        requests.append(body)
        data = json.dumps({'filepath': '/home/test/test space/α.typ', 'line': 12, 'column': 4,
                           'opened': body.get('open') is True and accept_open}
                          if ok else {'error': 'test refusal'}).encode()
        self.send_response(200 if ok else 500)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
meta = work / 'mock.typst-sync.json'
meta.write_text(json.dumps({'port': server.server_port, 'token': 'test-capability'}))
win_meta = subprocess.check_output(['wslpath', '-w', str(meta)], text=True).strip()
cases = [
    (win_meta, '101', '1', '--resolve-only'),
    (win_meta, '101', '1', '-PrintCommand'),
    (r'C:\test space\file.tex', '5', '2', '-PrintCommand'),
    ('/home/test/test space/résumé.typ', '7', '9', '-PrintCommand'),
    (r'\\wsl$\Ubuntu\home\test\quoted "name".typ', '3', '6', '-PrintCommand'),
    (win_meta, '102', '1', '--resolve-only'),
]
try:
    for source, line, column, flag in cases:
        result = subprocess.run([str(exe), source, line, column, flag], cwd='/mnt/c/Windows',
                                capture_output=True, text=True, encoding='utf-8', timeout=25, env=env)
        if line == '102':
            assert result.returncode == 1 and 'test refusal' in result.stderr, result
        else:
            assert result.returncode == 0, result.stderr
            data = json.loads(result.stdout)
            if flag == '--resolve-only':
                assert data == {'filepath': '/home/test/test space/α.typ', 'line': 12, 'column': 4}
            elif source == win_meta:
                assert data['arguments'][-1] == '/home/test/test space/α.typ:12:4'
            elif source.startswith('C:'):
                assert '--remote' not in data['arguments']
                assert data['arguments'][-1] == 'C:/test space/file.tex:5:2'
            elif source.startswith('\\\\wsl$'):
                assert data['arguments'][-1] == '/home/test/quoted "name".typ:3:6'
            else:
                assert data['arguments'][-1] == '/home/test/test space/résumé.typ:7:9'
        print('PASS', source, flag, flush=True)
    assert all('open' not in body for body in requests), 'Diagnostic flags must not open the editor'
    for accept_open in [True, False]:
        result = subprocess.run([str(exe), win_meta, '101', '1'], cwd='/mnt/c/Windows',
                                capture_output=True, text=True, encoding='utf-8', timeout=25, env=env)
        assert requests[-1]['open'] is True
        if accept_open:
            assert result.returncode == 0 and not result.stdout and not result.stderr, result
        else:
            assert result.returncode == 1 and 'EXPECTED_TEST_CLI_FALLBACK' in result.stderr, result
        print('PASS native IPC fast path' if accept_open else 'PASS native CLI fallback', flush=True)
finally:
    server.shutdown()
print('Native HTTP, authentication, errors, UNC/Linux/Windows paths, spaces, quotes and Unicode passed.')

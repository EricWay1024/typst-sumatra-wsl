"""Exercise the native Windows client without opening VS Code.

Usage: python3 -B test-windows.py /persistent/scratch/open-in-vscode.exe
Outputs stay beside the test executable, never in the OS temporary directory.
"""
import http.server
import json
from pathlib import Path
import subprocess
import sys
import threading

exe = Path(sys.argv[1]).resolve()
work = exe.parent


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        ok = (self.path == '/resolve'
              and self.headers.get('Authorization') == 'Bearer test-capability'
              and body['id'] == 101)
        data = json.dumps({'filepath': '/home/test/test space/α.typ', 'line': 12, 'column': 4}
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
                                capture_output=True, text=True, encoding='utf-8', timeout=25)
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
finally:
    server.shutdown()
print('Native HTTP, authentication, errors, UNC/Linux/Windows paths, spaces, quotes and Unicode passed.')

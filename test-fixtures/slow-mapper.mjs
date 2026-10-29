#!/usr/bin/env node
// Lifecycle fixture only: deliberately slow compilation, not a Typst renderer.
// Tiny WebSocket endpoints exercise the bridge's real startup/idle handling.
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';

fs.appendFileSync(process.env.SLOW_MAPPER_STARTS, `${process.pid}\n`);
let control, ready = false;
function send(socket, message) {
  if (!socket || socket.destroyed) return;
  const body = Buffer.from(JSON.stringify(message));
  const header = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, 0, 0]);
  if (body.length >= 126) header.writeUInt16BE(body.length, 2);
  socket.write(Buffer.concat([header, body]));
}
async function endpoint(direction) {
  const server = http.createServer();
  server.on('upgrade', (request, socket) => {
    const accept = crypto.createHash('sha1').update(request.headers['sec-websocket-key'] +
      '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('error', () => {});
    socket.on('end', () => socket.end());
    if (direction === 'control') control = socket;
    else socket.on('data', chunk => {
      if ((chunk[0] & 15) === 8) { socket.end(); return; }
      if (!ready) throw Error('Bridge queried the mapper before compilation completed');
      send(control, { event: 'editorScrollTo', filepath: process.argv.at(-1), start: [0, 0] });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}
console.error('Control panel server listening on: 127.0.0.1:' + await endpoint('control'));
console.error('Data plane server listening on: 127.0.0.1:' + await endpoint('data'));
setTimeout(() => {
  ready = true;
  console.error('compilation succeeded');
  send(control, { event: 'compileStatus', kind: 'CompileSuccess' });
}, 22500);

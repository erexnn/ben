const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = __dirname;
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  const file = pathname === '/' ? 'index.html' : path.basename(pathname);
  const types = { 'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8', 'style.css': 'text/css; charset=utf-8' };
  fs.readFile(path.join(root, file), (err, data) => { if (err) { res.writeHead(404); return res.end('Not found'); } res.writeHead(200, { 'Content-Type': types[file] || 'application/octet-stream' }); res.end(data); });
});
const rooms = new Map();
function send(ws, value) {
  if (ws.destroyed) return;
  const data = Buffer.from(JSON.stringify(value)); let header;
  if (data.length < 126) header = Buffer.from([0x81, data.length]);
  else if (data.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(data.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
  ws.write(Buffer.concat([header, data]));
}
server.on('upgrade', (req, ws) => {
  const key = req.headers['sec-websocket-key']; if (!key) return ws.destroy();
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  ws.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  ws.buffer = Buffer.alloc(0); let room, peerId, name;
  ws.on('data', chunk => {
    ws.buffer = Buffer.concat([ws.buffer, chunk]);
    while (ws.buffer.length >= 2) {
      const opcode = ws.buffer[0] & 15; const masked = !!(ws.buffer[1] & 128); let length = ws.buffer[1] & 127; let offset = 2;
      if (length === 126) { if (ws.buffer.length < 4) return; length = ws.buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (ws.buffer.length < 10) return; const n = ws.buffer.readBigUInt64BE(2); if (n > 1000000n) return ws.destroy(); length = Number(n); offset = 10; }
      const maskLen = masked ? 4 : 0; if (ws.buffer.length < offset + maskLen + length) return;
      const mask = masked ? ws.buffer.subarray(offset, offset + 4) : null; offset += maskLen;
      const payload = Buffer.from(ws.buffer.subarray(offset, offset + length)); ws.buffer = ws.buffer.subarray(offset + length);
      if (opcode === 8) { ws.end(); return; } if (opcode === 9) { ws.write(Buffer.from([0x8a, 0])); continue; } if (opcode !== 1) continue;
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      let msg; try { msg = JSON.parse(payload.toString()); } catch { continue; }
      if (msg.type === 'join') {
        room = String(msg.room || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); name = String(msg.name || 'Misafir').trim().slice(0, 24) || 'Misafir';
        if (!room) { send(ws, { type: 'error', message: 'Oda kodu gerekli.' }); continue; }
        peerId = Math.random().toString(36).slice(2, 9); if (!rooms.has(room)) rooms.set(room, new Map()); const peers = rooms.get(room);
        send(ws, { type: 'joined', id: peerId, peers: [...peers.values()].map(p => ({ id: p.id, name: p.name })) });
        for (const p of peers.values()) send(p.ws, { type: 'peer-joined', id: peerId, name }); peers.set(peerId, { id: peerId, name, ws });
      } else if (room && ['offer', 'answer', 'candidate', 'mute'].includes(msg.type)) {
        const to = rooms.get(room)?.get(msg.to); if (to) send(to.ws, { ...msg, from: peerId, name });
      }
    }
  });
  ws.on('close', () => { if (!room || !peerId) return; const peers = rooms.get(room); peers?.delete(peerId); for (const p of peers?.values() || []) send(p.ws, { type: 'peer-left', id: peerId }); if (peers?.size === 0) rooms.delete(room); });
});
const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`Sesli Sohbet hazır: http://localhost:${port}`));


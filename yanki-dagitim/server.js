const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const { Pool } = require('pg');
const scrypt = promisify(crypto.scrypt);
const root = __dirname;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined, max: 8 });
const cookieName = 'yanki_session';
const sessionMs = 30 * 24 * 60 * 60 * 1000;
function json(res, status, body, headers = {}) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(body)); }
function readJson(req) { return new Promise((resolve, reject) => { let raw = ''; req.on('data', chunk => { raw += chunk; if (raw.length > 900000) { reject(Object.assign(new Error('İstek çok büyük.'), { status: 413 })); req.destroy(); } }); req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(Object.assign(new Error('Geçersiz istek.'), { status: 400 })); } }); req.on('error', reject); }); }
function cookies(req) { return Object.fromEntries((req.headers.cookie || '').split(';').map(x => x.trim()).filter(Boolean).map(x => { const i=x.indexOf('='); return [x.slice(0,i), decodeURIComponent(x.slice(i+1))]; })); }
function sessionCookie(token, maxAge = 60 * 60 * 24 * 30) { return `${cookieName}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`; }
function publicUser(row) { return { id: row.id, username: row.username, email: row.email, avatar: row.avatar_data || null }; }
async function getUser(req) { const token = cookies(req)[cookieName]; if (!token) return null; const tokenHash = crypto.createHash('sha256').update(token).digest('hex'); const r = await pool.query('SELECT u.id,u.username,u.email,u.avatar_data FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>NOW()', [tokenHash]); return r.rows[0] || null; }
async function createSession(userId, res) { const token = crypto.randomBytes(32).toString('base64url'); const hash = crypto.createHash('sha256').update(token).digest('hex'); const expiry = new Date(Date.now() + sessionMs); await pool.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)', [hash,userId,expiry]); res.setHeader('Set-Cookie', sessionCookie(token)); }
async function authApi(req, res, pathname) {
  if (pathname === '/api/register' && req.method === 'POST') {
    const b = await readJson(req); const username=String(b.username||'').trim(); const email=String(b.email||'').trim().toLowerCase(); const password=String(b.password||'');
    if (!/^[A-Za-z0-9_-]{3,20}$/.test(username)) return json(res,400,{error:'Kullanıcı adı 3–20 karakter olmalı; harf, rakam, _ ve - kullanabilirsin.'});
    if (email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res,400,{error:'Geçerli bir e-posta adresi yaz.'});
    if (password.length<8 || password.length>200) return json(res,400,{error:'Şifre en az 8 karakter olmalı.'});
    const salt=crypto.randomBytes(16); const hash=await scrypt(password,salt,64);
    try { const r=await pool.query('INSERT INTO users(username,email,password_hash) VALUES($1,$2,$3) RETURNING id,username,email,avatar_data',[username,email,`${salt.toString('hex')}:${hash.toString('hex')}`]); await createSession(r.rows[0].id,res); return json(res,201,{user:publicUser(r.rows[0])}); }
    catch(e){if(e.code==='23505')return json(res,409,{error:'Bu kullanıcı adı veya e-posta zaten kullanılıyor.'});throw e;}
  }
  if (pathname === '/api/login' && req.method === 'POST') {
    const b=await readJson(req); const email=String(b.email||'').trim().toLowerCase(); const password=String(b.password||''); const r=await pool.query('SELECT id,username,email,avatar_data,password_hash FROM users WHERE email=$1',[email]); const row=r.rows[0];
    if(!row)return json(res,401,{error:'E-posta veya şifre hatalı.'}); const [saltHex,hashHex]=row.password_hash.split(':'); const actual=await scrypt(password,Buffer.from(saltHex,'hex'),64); const expected=Buffer.from(hashHex,'hex');
    if(actual.length!==expected.length||!crypto.timingSafeEqual(actual,expected))return json(res,401,{error:'E-posta veya şifre hatalı.'}); await createSession(row.id,res); return json(res,200,{user:publicUser(row)});
  }
  if (pathname === '/api/logout' && req.method === 'POST') { const token=cookies(req)[cookieName]; if(token)await pool.query('DELETE FROM sessions WHERE token_hash=$1',[crypto.createHash('sha256').update(token).digest('hex')]); return json(res,200,{ok:true},{'Set-Cookie':sessionCookie('',0)}); }
  const user=await getUser(req);
  if (pathname === '/api/me' && req.method === 'GET') return user?json(res,200,{user:publicUser(user)}):json(res,401,{error:'Giriş yapman gerekiyor.'});
  if (pathname === '/api/profile' && req.method === 'PATCH') {
    if(!user)return json(res,401,{error:'Giriş yapman gerekiyor.'}); const b=await readJson(req); const username=String(b.username||'').trim();
    if(!/^[A-Za-z0-9_-]{3,20}$/.test(username))return json(res,400,{error:'Kullanıcı adı 3–20 karakter olmalı; harf, rakam, _ ve - kullanabilirsin.'});
    let avatar=b.avatar; if(avatar!==undefined&&avatar!==null){if(typeof avatar!=='string'||!/^data:image\/(png|jpeg|webp);base64,/.test(avatar)||avatar.length>700000)return json(res,400,{error:'Fotoğraf PNG, JPG veya WebP olmalı ve 512 KB’ı aşmamalı.'});}
    try { const r=avatar===undefined?await pool.query('UPDATE users SET username=$1 WHERE id=$2 RETURNING id,username,email,avatar_data',[username,user.id]):await pool.query('UPDATE users SET username=$1,avatar_data=$2 WHERE id=$3 RETURNING id,username,email,avatar_data',[username,avatar,user.id]); return json(res,200,{user:publicUser(r.rows[0])}); }
    catch(e){if(e.code==='23505')return json(res,409,{error:'Bu kullanıcı adı zaten kullanılıyor.'});throw e;}
  }
  return json(res,404,{error:'Bulunamadı.'});
}
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  if(pathname.startsWith('/api/')){try{return await authApi(req,res,pathname)}catch(e){console.error('API error:',e.message);return json(res,e.status||500,{error:e.status?e.message:'Sunucu hatası. Biraz sonra yeniden dene.'})}}
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
server.on('upgrade', async (req, ws) => {
  let user;
  try { user = await getUser(req); } catch { user = null; }
  if (!user) { ws.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return ws.destroy(); }
  const key = req.headers['sec-websocket-key']; if (!key) return ws.destroy();
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  ws.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  ws.buffer = Buffer.alloc(0); let room, peerId, name=user.username;
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
        room = String(msg.room || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
        if (!room) { send(ws, { type: 'error', message: 'Oda kodu gerekli.' }); continue; }
        if (!rooms.has(room)) {
          if (!msg.create) { send(ws, { type: 'error', message: 'Bu oda bulunamadı. Oda kodunu kontrol et.' }); continue; }
          rooms.set(room, new Map());
        }
        peerId = Math.random().toString(36).slice(2, 9); const peers = rooms.get(room);
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
async function start() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL tanımlı değil.');
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    username VARCHAR(20) NOT NULL,
    email VARCHAR(254) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    avatar_data TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (LOWER(username))');
  await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash CHAR(64) PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL
  )`);
  server.listen(port, () => console.log(`Sesli Sohbet hazır: http://localhost:${port}`));
}
start().catch(error => { console.error('Başlatma hatası:', error.message); process.exit(1); });


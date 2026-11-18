const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
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
function codeDigest(code) { return crypto.createHmac('sha256', process.env.EMAIL_CODE_SECRET || 'local-yanki-email-code-secret').update(code).digest('hex'); }
async function sendVerificationCode(userId,email,force=false) {
  const previous=await pool.query('SELECT sent_at FROM yanki_verification_codes WHERE user_id=$1',[userId]);
  if(!force&&previous.rows[0]&&Date.now()-new Date(previous.rows[0].sent_at).getTime()<60000)return false;
  const code=String(crypto.randomInt(100000,1000000));
  await pool.query('INSERT INTO yanki_verification_codes(user_id,code_hash,expires_at,sent_at,attempts) VALUES($1,$2,NOW()+INTERVAL \'10 minutes\',NOW(),0) ON CONFLICT(user_id) DO UPDATE SET code_hash=EXCLUDED.code_hash,expires_at=EXCLUDED.expires_at,sent_at=EXCLUDED.sent_at,attempts=0',[userId,codeDigest(code)]);
  try { await deliverCode(email,code); return true; }
  catch(error) { await pool.query('DELETE FROM yanki_verification_codes WHERE user_id=$1',[userId]); throw error; }
}
async function deliverCode(email, code) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) throw new Error('Gmail gönderici hesabı ayarlanmamış.');
  const transporter=nodemailer.createTransport({service:'gmail',auth:{user:process.env.GMAIL_USER,pass:process.env.GMAIL_APP_PASSWORD.replace(/\s/g,'')}});
  await transporter.sendMail({from:`Yankı <${process.env.GMAIL_USER}>`,to:email,subject:'Yankı e-posta doğrulama kodun',text:`Yankı hesabını doğrulamak için bu kodu kullan: ${code}\n\nKod 10 dakika içinde sona erer. Bu isteği sen yapmadıysan bu e-postayı yok say.`,html:`<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:28px;color:#24221f"><div style="font-size:13px;letter-spacing:4px;color:#e7462f">YANKI / SES ODASI</div><h1 style="font-family:Georgia,serif;font-weight:500">E-postanı doğrula</h1><p>Hesabını açmak için bu kodu kullan:</p><div style="font-size:32px;letter-spacing:8px;font-weight:bold;padding:18px;background:#f4ead8;border:1px solid #24221f;text-align:center">${code}</div><p style="font-size:13px;color:#67615a">Kod 10 dakika içinde sona erer. Bu isteği sen yapmadıysan bu e-postayı yok say.</p></div>`});
}
async function getUser(req) { const token = cookies(req)[cookieName]; if (!token) return null; const tokenHash = crypto.createHash('sha256').update(token).digest('hex'); const r = await pool.query('SELECT u.id,u.username,u.email,u.avatar_data FROM yanki_sessions s JOIN yanki_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>NOW()', [tokenHash]); return r.rows[0] || null; }
async function createSession(userId, res) { const token = crypto.randomBytes(32).toString('base64url'); const hash = crypto.createHash('sha256').update(token).digest('hex'); const expiry = new Date(Date.now() + sessionMs); await pool.query('INSERT INTO yanki_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)', [hash,userId,expiry]); res.setHeader('Set-Cookie', sessionCookie(token)); }
async function authApi(req, res, pathname) {
  if (pathname === '/api/register' && req.method === 'POST') {
    const b = await readJson(req); const username=String(b.username||'').trim(); const email=String(b.email||'').trim().toLowerCase(); const password=String(b.password||'');
    if (!/^[A-Za-z0-9_-]{3,20}$/.test(username)) return json(res,400,{error:'Kullanıcı adı 3–20 karakter olmalı; harf, rakam, _ ve - kullanabilirsin.'});
    if (email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res,400,{error:'Geçerli bir e-posta adresi yaz.'});
    if (password.length<8 || password.length>200) return json(res,400,{error:'Şifre en az 8 karakter olmalı.'});
    if(!process.env.GMAIL_USER||!process.env.GMAIL_APP_PASSWORD)return json(res,503,{error:'E-posta doğrulama göndericisi henüz ayarlanmamış.'});
    const salt=crypto.randomBytes(16); const hash=await scrypt(password,salt,64); const passwordHash=`${salt.toString('hex')}:${hash.toString('hex')}`; const code=String(crypto.randomInt(100000,1000000)); let user;
    try {
      const existing=await pool.query('SELECT id,email_verified FROM yanki_users WHERE email=$1',[email]);
      if(existing.rows[0]?.email_verified)return json(res,409,{error:'Bu e-posta zaten kayıtlı. Giriş yapmayı dene.'});
      if(existing.rows[0]){
        const r=await pool.query('UPDATE yanki_users SET username=$1,password_hash=$2 WHERE id=$3 RETURNING id,username,email,avatar_data',[username,passwordHash,existing.rows[0].id]);user=r.rows[0];
      }else{
        const r=await pool.query('INSERT INTO yanki_users(username,email,password_hash,email_verified) VALUES($1,$2,$3,FALSE) RETURNING id,username,email,avatar_data',[username,email,passwordHash]);user=r.rows[0];
      }
      await pool.query('INSERT INTO yanki_verification_codes(user_id,code_hash,expires_at,sent_at,attempts) VALUES($1,$2,NOW()+INTERVAL \'10 minutes\',NOW(),0) ON CONFLICT(user_id) DO UPDATE SET code_hash=EXCLUDED.code_hash,expires_at=EXCLUDED.expires_at,sent_at=EXCLUDED.sent_at,attempts=0',[user.id,codeDigest(code)]);
    }
    catch(e){
      if(e.code==='23505'&&String(e.constraint||'').includes('username'))return json(res,409,{error:'Bu kullanıcı adı zaten kullanılıyor. Başka bir kullanıcı adı seç.'});
      if(e.code==='23505'&&String(e.constraint||'').includes('email'))return json(res,409,{error:'Bu e-posta zaten kayıtlı. Giriş yapmayı dene.'});
      if(e.code==='23505')return json(res,409,{error:'Kullanıcı adı veya e-posta kullanımda. Bilgileri kontrol et.'});
      throw e;
    }
    try { await deliverCode(email,code); return json(res,202,{pending:true,email}); }
    catch(e){await pool.query('DELETE FROM yanki_verification_codes WHERE user_id=$1',[user.id]);console.error('Verification email delivery failed.');return json(res,502,{error:'Doğrulama e-postası gönderilemedi. Gmail ayarlarını kontrol et veya biraz sonra yeniden dene.'});}
  }
  if (pathname === '/api/login' && req.method === 'POST') {
    const b=await readJson(req); const email=String(b.email||'').trim().toLowerCase(); const password=String(b.password||''); const r=await pool.query('SELECT id,username,email,avatar_data,password_hash,email_verified FROM yanki_users WHERE email=$1',[email]); const row=r.rows[0];
    if(!row)return json(res,401,{error:'E-posta veya şifre hatalı.'}); const [saltHex,hashHex]=row.password_hash.split(':'); const actual=await scrypt(password,Buffer.from(saltHex,'hex'),64); const expected=Buffer.from(hashHex,'hex');
    if(actual.length!==expected.length||!crypto.timingSafeEqual(actual,expected))return json(res,401,{error:'E-posta veya şifre hatalı.'});
    if(!row.email_verified){try{const codeSent=await sendVerificationCode(row.id,row.email);return json(res,403,{error:codeSent?'Doğrulama kodunu e-posta adresine gönderdik.':'Kod kısa süre önce gönderildi. Gelen kutunu ve spam klasörünü kontrol et.',needsVerification:true,email:row.email,codeSent});}catch(error){console.error('Verification email delivery failed.');return json(res,502,{error:'Doğrulama e-postası gönderilemedi. Render e-posta ayarlarını kontrol etmek gerekiyor.',needsVerification:true,email:row.email});}}
    await createSession(row.id,res); return json(res,200,{user:publicUser(row)});
  }
  if(pathname==='/api/verify-email'&&req.method==='POST'){
    const b=await readJson(req);const email=String(b.email||'').trim().toLowerCase();const code=String(b.code||'').trim();if(!/^\d{6}$/.test(code))return json(res,400,{error:'6 haneli kodu gir.'});
    const u=await pool.query('SELECT id,username,email,avatar_data,email_verified FROM yanki_users WHERE email=$1',[email]);const user=u.rows[0];if(!user)return json(res,400,{error:'Kod geçersiz veya süresi dolmuş.'});if(user.email_verified){await createSession(user.id,res);return json(res,200,{user:publicUser(user)});}
    const v=await pool.query('SELECT code_hash,expires_at,attempts FROM yanki_verification_codes WHERE user_id=$1',[user.id]);const row=v.rows[0];if(!row||new Date(row.expires_at)<new Date()||row.attempts>=5)return json(res,400,{error:'Kod geçersiz veya süresi dolmuş. Yeni kod iste.'});
    const actual=Buffer.from(codeDigest(code),'hex'),expected=Buffer.from(row.code_hash,'hex');if(actual.length!==expected.length||!crypto.timingSafeEqual(actual,expected)){await pool.query('UPDATE yanki_verification_codes SET attempts=attempts+1 WHERE user_id=$1',[user.id]);return json(res,400,{error:'Kod yanlış. Tekrar dene.'});}
    await pool.query('UPDATE yanki_users SET email_verified=TRUE WHERE id=$1',[user.id]);await pool.query('DELETE FROM yanki_verification_codes WHERE user_id=$1',[user.id]);await createSession(user.id,res);return json(res,200,{user:publicUser(user)});
  }
  if(pathname==='/api/resend-code'&&req.method==='POST'){
    const b=await readJson(req);const email=String(b.email||'').trim().toLowerCase();const r=await pool.query('SELECT id,email_verified FROM yanki_users WHERE email=$1',[email]);const user=r.rows[0];if(!user||user.email_verified)return json(res,200,{ok:true});
    const v=await pool.query('SELECT sent_at FROM yanki_verification_codes WHERE user_id=$1',[user.id]);if(v.rows[0]&&Date.now()-new Date(v.rows[0].sent_at).getTime()<60000)return json(res,429,{error:'Yeni kod istemeden önce bir dakika bekle.'});
    try{await sendVerificationCode(user.id,email,true);return json(res,200,{ok:true})}catch(e){console.error('Verification email delivery failed.');return json(res,502,{error:'Doğrulama e-postası gönderilemedi. Render e-posta ayarlarını kontrol etmek gerekiyor.'})}
  }
  if (pathname === '/api/logout' && req.method === 'POST') { const token=cookies(req)[cookieName]; if(token)await pool.query('DELETE FROM yanki_sessions WHERE token_hash=$1',[crypto.createHash('sha256').update(token).digest('hex')]); return json(res,200,{ok:true},{'Set-Cookie':sessionCookie('',0)}); }
  const user=await getUser(req);
  if (pathname === '/api/me' && req.method === 'GET') return user?json(res,200,{user:publicUser(user)}):json(res,401,{error:'Giriş yapman gerekiyor.'});
  if (pathname === '/api/profile' && req.method === 'PATCH') {
    if(!user)return json(res,401,{error:'Giriş yapman gerekiyor.'}); const b=await readJson(req); const username=String(b.username||'').trim();
    if(!/^[A-Za-z0-9_-]{3,20}$/.test(username))return json(res,400,{error:'Kullanıcı adı 3–20 karakter olmalı; harf, rakam, _ ve - kullanabilirsin.'});
    let avatar=b.avatar; if(avatar!==undefined&&avatar!==null){if(typeof avatar!=='string'||!/^data:image\/(png|jpeg|webp);base64,/.test(avatar)||avatar.length>700000)return json(res,400,{error:'Fotoğraf PNG, JPG veya WebP olmalı ve 512 KB’ı aşmamalı.'});}
    try { const r=avatar===undefined?await pool.query('UPDATE yanki_users SET username=$1 WHERE id=$2 RETURNING id,username,email,avatar_data',[username,user.id]):await pool.query('UPDATE yanki_users SET username=$1,avatar_data=$2 WHERE id=$3 RETURNING id,username,email,avatar_data',[username,avatar,user.id]); return json(res,200,{user:publicUser(r.rows[0])}); }
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
const roomLives = new Map();
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
        const live=roomLives.get(room)||null;
        send(ws, { type: 'joined', id: peerId, peers: [...peers.values()].map(p => ({ id: p.id, name: p.name })), live });
        for (const p of peers.values()) send(p.ws, { type: 'peer-joined', id: peerId, name }); peers.set(peerId, { id: peerId, name, ws });
        if(live&&live.id!==peerId)send(ws,{type:'live-start',id:live.id,name:live.name});
      } else if(room&&msg.type==='live-start'){
        const active=roomLives.get(room);if(active&&active.id!==peerId){send(ws,{type:'live-error',message:'Bu odada zaten bir yayın açık.'});continue;}
        const live={id:peerId,name};roomLives.set(room,live);for(const p of rooms.get(room)?.values()||[])if(p.id!==peerId)send(p.ws,{type:'live-start',...live});
      } else if(room&&msg.type==='live-stop'){
        if(roomLives.get(room)?.id===peerId){roomLives.delete(room);for(const p of rooms.get(room)?.values()||[])if(p.id!==peerId)send(p.ws,{type:'live-stop',id:peerId});}
      } else if(room&&msg.type==='live-viewer-join'){
        const live=roomLives.get(room);const broadcaster=live&&rooms.get(room)?.get(live.id);if(broadcaster)send(broadcaster.ws,{type:'live-viewer-join',from:peerId,name});else send(ws,{type:'live-stop',id:live?.id});
      } else if(room&&['live-offer','live-answer','live-candidate'].includes(msg.type)){
        const to=rooms.get(room)?.get(msg.to);if(to)send(to.ws,{...msg,from:peerId,name});
      } else if (room && ['offer', 'answer', 'candidate', 'mute'].includes(msg.type)) {
        const to = rooms.get(room)?.get(msg.to); if (to) send(to.ws, { ...msg, from: peerId, name });
      }
    }
  });
  ws.on('close', () => { if (!room || !peerId) return; const peers = rooms.get(room); if(roomLives.get(room)?.id===peerId){roomLives.delete(room);for(const p of peers?.values()||[])if(p.id!==peerId)send(p.ws,{type:'live-stop',id:peerId});}peers?.delete(peerId); for (const p of peers?.values() || []) send(p.ws, { type: 'peer-left', id: peerId }); if (peers?.size === 0) { rooms.delete(room); roomLives.delete(room); } });
});
const port = process.env.PORT || 3000;
async function start() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL tanımlı değil.');
  await pool.query(`CREATE TABLE IF NOT EXISTS yanki_users (
    id BIGSERIAL PRIMARY KEY,
    username VARCHAR(20) NOT NULL,
    email VARCHAR(254) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    avatar_data TEXT,
    email_verified BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query('ALTER TABLE yanki_users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT TRUE');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS yanki_users_username_lower_idx ON yanki_users (LOWER(username))');
  await pool.query(`CREATE TABLE IF NOT EXISTS yanki_sessions (
    token_hash CHAR(64) PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES yanki_users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS yanki_verification_codes (
    user_id BIGINT PRIMARY KEY REFERENCES yanki_users(id) ON DELETE CASCADE,
    code_hash CHAR(64) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    sent_at TIMESTAMPTZ NOT NULL,
    attempts SMALLINT NOT NULL DEFAULT 0
  )`);
  server.listen(port, () => console.log(`Sesli Sohbet hazır: http://localhost:${port}`));
}
start().catch(error => { console.error('Başlatma hatası:', error.message); process.exit(1); });


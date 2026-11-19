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
async function getUser(req) { const token = cookies(req)[cookieName]; if (!token) return null; const tokenHash = crypto.createHash('sha256').update(token).digest('hex'); const r = await pool.query('SELECT u.id,u.username,u.email,u.avatar_data FROM yanki_sessions s JOIN yanki_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>NOW()', [tokenHash]); return r.rows[0] || null; }
async function createSession(userId, res) { const token = crypto.randomBytes(32).toString('base64url'); const hash = crypto.createHash('sha256').update(token).digest('hex'); const expiry = new Date(Date.now() + sessionMs); await pool.query('INSERT INTO yanki_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)', [hash,userId,expiry]); res.setHeader('Set-Cookie', sessionCookie(token)); }
async function authApi(req, res, pathname) {
  if (pathname === '/api/register' && req.method === 'POST') {
    const b = await readJson(req); const username=String(b.username||'').trim(); const email=String(b.email||'').trim().toLowerCase(); const password=String(b.password||'');
    if (!/^[A-Za-z0-9_-]{3,20}$/.test(username)) return json(res,400,{error:'Kullanıcı adı 3–20 karakter olmalı; harf, rakam, _ ve - kullanabilirsin.'});
    if (email.length>254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res,400,{error:'Geçerli bir e-posta adresi yaz.'});
    if (password.length<8 || password.length>200) return json(res,400,{error:'Şifre en az 8 karakter olmalı.'});
    const salt=crypto.randomBytes(16); const hash=await scrypt(password,salt,64); const passwordHash=`${salt.toString('hex')}:${hash.toString('hex')}`; let user;
    try {
      const existing=await pool.query('SELECT id FROM yanki_users WHERE email=$1',[email]);
      if(existing.rows[0])return json(res,409,{error:'Bu e-posta zaten kayıtlı. Giriş yapmayı dene.'});
      const r=await pool.query('INSERT INTO yanki_users(username,email,password_hash,email_verified) VALUES($1,$2,$3,TRUE) RETURNING id,username,email,avatar_data',[username,email,passwordHash]);user=r.rows[0];
    }
    catch(e){
      if(e.code==='23505'&&String(e.constraint||'').includes('username'))return json(res,409,{error:'Bu kullanıcı adı zaten kullanılıyor. Başka bir kullanıcı adı seç.'});
      if(e.code==='23505'&&String(e.constraint||'').includes('email'))return json(res,409,{error:'Bu e-posta zaten kayıtlı. Giriş yapmayı dene.'});
      if(e.code==='23505')return json(res,409,{error:'Kullanıcı adı veya e-posta kullanımda. Bilgileri kontrol et.'});
      throw e;
    }
    await createSession(user.id,res);return json(res,201,{user:publicUser(user)});
  }
  if (pathname === '/api/login' && req.method === 'POST') {
    const b=await readJson(req); const email=String(b.email||'').trim().toLowerCase(); const password=String(b.password||''); const r=await pool.query('SELECT id,username,email,avatar_data,password_hash FROM yanki_users WHERE email=$1',[email]); const row=r.rows[0];
    if(!row)return json(res,401,{error:'E-posta veya şifre hatalı.'}); const [saltHex,hashHex]=row.password_hash.split(':'); const actual=await scrypt(password,Buffer.from(saltHex,'hex'),64); const expected=Buffer.from(hashHex,'hex');
    if(actual.length!==expected.length||!crypto.timingSafeEqual(actual,expected))return json(res,401,{error:'E-posta veya şifre hatalı.'});
    await createSession(row.id,res); return json(res,200,{user:publicUser(row)});
  }
  const user=await getUser(req);
  if(pathname.startsWith('/api/')&&!user)return json(res,401,{error:'Devam etmek için giriş yap.'});
  if(pathname==='/api/communities'&&req.method==='GET'){
    const r=await pool.query(`SELECT c.id,c.name,c.invite_code,m.role,(SELECT COUNT(*) FROM yanki_community_members mm WHERE mm.community_id=c.id)::int AS member_count FROM yanki_community_members m JOIN yanki_communities c ON c.id=m.community_id WHERE m.user_id=$1 ORDER BY c.created_at,c.id`,[user.id]);return json(res,200,{communities:r.rows});
  }
  if(pathname==='/api/communities'&&req.method==='POST'){
    const b=await readJson(req),name=String(b.name||'').trim().slice(0,40);if(name.length<2)return json(res,400,{error:'Topluluk adı en az 2 karakter olmalı.'});
    const client=await pool.connect();try{await client.query('BEGIN');const invite=crypto.randomBytes(4).toString('hex').toUpperCase();const c=await client.query('INSERT INTO yanki_communities(name,owner_id,invite_code) VALUES($1,$2,$3) RETURNING id,name,invite_code',[name,user.id,invite]);const id=c.rows[0].id;await client.query('INSERT INTO yanki_community_members(community_id,user_id,role) VALUES($1,$2,\'owner\')',[id,user.id]);await client.query('INSERT INTO yanki_channels(community_id,name,type,position) VALUES($1,\'genel\',\'text\',0),($1,\'sohbet\',\'voice\',1)',[id]);await client.query('COMMIT');return json(res,201,{community:{...c.rows[0],role:'owner',member_count:1}})}catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
  }
  if(pathname==='/api/communities/join'&&req.method==='POST'){
    const b=await readJson(req),code=String(b.code||'').trim().toUpperCase();const c=await pool.query('SELECT id,name,invite_code FROM yanki_communities WHERE invite_code=$1',[code]);if(!c.rows[0])return json(res,404,{error:'Bu davet koduna ait topluluk bulunamadı.'});await pool.query('INSERT INTO yanki_community_members(community_id,user_id,role) VALUES($1,$2,\'member\') ON CONFLICT(community_id,user_id) DO NOTHING',[c.rows[0].id,user.id]);return json(res,200,{community:{...c.rows[0],role:'member'}});
  }
  if(pathname==='/api/community'&&req.method==='GET'){
    const id=String(new URL(req.url,`http://${req.headers.host||'localhost'}`).searchParams.get('id')||'');const access=await pool.query('SELECT c.id,c.name,c.invite_code,m.role FROM yanki_communities c JOIN yanki_community_members m ON m.community_id=c.id WHERE c.id=$1 AND m.user_id=$2',[id,user.id]);if(!access.rows[0])return json(res,404,{error:'Topluluk bulunamadı veya üyeliğin yok.'});const [channels,members]=await Promise.all([pool.query('SELECT id,name,type,position FROM yanki_channels WHERE community_id=$1 ORDER BY position,id',[id]),pool.query('SELECT u.id,u.username,u.avatar_data AS avatar,m.role FROM yanki_community_members m JOIN yanki_users u ON u.id=m.user_id WHERE m.community_id=$1 ORDER BY CASE m.role WHEN \'owner\' THEN 0 ELSE 1 END,u.username',[id])]);return json(res,200,{community:access.rows[0],channels:channels.rows,members:members.rows});
  }
  if(pathname==='/api/channels'&&req.method==='POST'){
    const b=await readJson(req),id=String(b.communityId||''),name=String(b.name||'').trim().toLowerCase().replace(/[^a-z0-9ğüşöçıİ_-]+/g,'-').replace(/^-|-$/g,'').slice(0,32),type=b.type==='voice'?'voice':'text';if(!name)return json(res,400,{error:'Kanal adı yaz.'});const role=await pool.query('SELECT role FROM yanki_community_members WHERE community_id=$1 AND user_id=$2',[id,user.id]);if(!role.rows[0])return json(res,404,{error:'Topluluk bulunamadı.'});if(!['owner','admin'].includes(role.rows[0].role))return json(res,403,{error:'Kanal oluşturma yetkin yok.'});const r=await pool.query('INSERT INTO yanki_channels(community_id,name,type,position) VALUES($1,$2,$3,(SELECT COALESCE(MAX(position),0)+1 FROM yanki_channels WHERE community_id=$1)) RETURNING id,name,type,position',[id,name,type]);return json(res,201,{channel:r.rows[0]});
  }
  if(pathname==='/api/messages'&&req.method==='GET'){
    const url=new URL(req.url,`http://${req.headers.host||'localhost'}`),channelId=url.searchParams.get('channelId'),after=url.searchParams.get('after')||'0';const access=await pool.query('SELECT 1 FROM yanki_channels c JOIN yanki_community_members m ON m.community_id=c.community_id WHERE c.id=$1 AND c.type=\'text\' AND m.user_id=$2',[channelId,user.id]);if(!access.rowCount)return json(res,404,{error:'Metin kanalı bulunamadı.'});const r=await pool.query('SELECT x.id,x.content,x.created_at,u.id AS user_id,u.username,u.avatar_data AS avatar FROM yanki_messages x JOIN yanki_users u ON u.id=x.user_id WHERE x.channel_id=$1 AND x.id>$2 ORDER BY x.id DESC LIMIT 80',[channelId,after]);return json(res,200,{messages:r.rows.reverse()});
  }
  if(pathname==='/api/messages'&&req.method==='POST'){
    const b=await readJson(req),channelId=String(b.channelId||''),content=String(b.content||'').trim();if(!content||content.length>4000)return json(res,400,{error:'Mesaj 1–4000 karakter arasında olmalı.'});const access=await pool.query('SELECT 1 FROM yanki_channels c JOIN yanki_community_members m ON m.community_id=c.community_id WHERE c.id=$1 AND c.type=\'text\' AND m.user_id=$2',[channelId,user.id]);if(!access.rowCount)return json(res,404,{error:'Metin kanalı bulunamadı.'});const r=await pool.query('INSERT INTO yanki_messages(channel_id,user_id,content) VALUES($1,$2,$3) RETURNING id,content,created_at',[channelId,user.id,content]);return json(res,201,{message:{...r.rows[0],user_id:user.id,username:user.username,avatar:user.avatar_data}});
  }
  if(pathname==='/api/reactions'&&req.method==='POST'){
    const b=await readJson(req),messageId=String(b.messageId||''),emoji=String(b.emoji||'');if(!['👍','❤️','😂','🔥','🎉'].includes(emoji))return json(res,400,{error:'Bu tepki kullanılamıyor.'});const access=await pool.query('SELECT 1 FROM yanki_messages x JOIN yanki_channels c ON c.id=x.channel_id JOIN yanki_community_members m ON m.community_id=c.community_id WHERE x.id=$1 AND m.user_id=$2',[messageId,user.id]);if(!access.rowCount)return json(res,404,{error:'Mesaj bulunamadı.'});const found=await pool.query('SELECT 1 FROM yanki_reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3',[messageId,user.id,emoji]);if(found.rowCount)await pool.query('DELETE FROM yanki_reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3',[messageId,user.id,emoji]);else await pool.query('INSERT INTO yanki_reactions(message_id,user_id,emoji) VALUES($1,$2,$3)',[messageId,user.id,emoji]);const counts=await pool.query('SELECT emoji,COUNT(*)::int AS count FROM yanki_reactions WHERE message_id=$1 GROUP BY emoji',[messageId]);return json(res,200,{reactions:counts.rows});
  }
  if (pathname === '/api/logout' && req.method === 'POST') { const token=cookies(req)[cookieName]; if(token)await pool.query('DELETE FROM yanki_sessions WHERE token_hash=$1',[crypto.createHash('sha256').update(token).digest('hex')]); return json(res,200,{ok:true},{'Set-Cookie':sessionCookie('',0)}); }
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
  await pool.query('UPDATE yanki_users SET email_verified=TRUE WHERE email_verified=FALSE');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS yanki_users_username_lower_idx ON yanki_users (LOWER(username))');
  await pool.query(`CREATE TABLE IF NOT EXISTS yanki_sessions (
    token_hash CHAR(64) PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES yanki_users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS yanki_communities (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(40) NOT NULL,
    owner_id BIGINT NOT NULL REFERENCES yanki_users(id) ON DELETE CASCADE,
    invite_code VARCHAR(16) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS yanki_community_members (
    community_id BIGINT NOT NULL REFERENCES yanki_communities(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES yanki_users(id) ON DELETE CASCADE,
    role VARCHAR(16) NOT NULL DEFAULT 'member',
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(community_id,user_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS yanki_channels (
    id BIGSERIAL PRIMARY KEY,
    community_id BIGINT NOT NULL REFERENCES yanki_communities(id) ON DELETE CASCADE,
    name VARCHAR(32) NOT NULL,
    type VARCHAR(8) NOT NULL CHECK(type IN ('text','voice')),
    position INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS yanki_messages (
    id BIGSERIAL PRIMARY KEY,
    channel_id BIGINT NOT NULL REFERENCES yanki_channels(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES yanki_users(id) ON DELETE CASCADE,
    content VARCHAR(4000) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS yanki_messages_channel_id_idx ON yanki_messages(channel_id,id)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS yanki_reactions (
    message_id BIGINT NOT NULL REFERENCES yanki_messages(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES yanki_users(id) ON DELETE CASCADE,
    emoji VARCHAR(8) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(message_id,user_id,emoji)
  )`);
  server.listen(port, () => console.log(`Sesli Sohbet hazır: http://localhost:${port}`));
}
start().catch(error => { console.error('Başlatma hatası:', error.message); process.exit(1); });


const $ = id => document.getElementById(id);
const welcome = $('welcome'), roomView = $('roomView'), roomInput = $('room'), nameInput = $('name'), authView = $('authView');
let socket, localStream, roomCode, myId, muted = false, currentUser = null, avatarData = null, profileAvatarChanged = false, pendingInvite = new URLSearchParams(location.search).get('room'), connections = new Map(), peerNames = new Map(), audioContext, analyser, meterFrame, verificationEmail = '', liveStream = null, liveBroadcaster = null, livePeers = new Map();
const palette = ['#384936','#454039','#3c4542','#4b3b3b','#3d3a4d','#4b4939'];
function toast(text){const el=$('toast');el.textContent=text;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2400)}
async function api(url,method='GET',body){const r=await fetch(url,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const data=await r.json().catch(()=>({error:'Sunucu yanıtı okunamadı.'}));if(!r.ok){const e=new Error(data.error||'İstek başarısız.');Object.assign(e,data);throw e}return data}
function paintAvatar(target,image,initial){target.replaceChildren();if(image){const img=document.createElement('img');img.src=image;img.alt='Profil fotoğrafı';target.append(img)}else{const span=document.createElement('span');span.textContent=(initial||'M')[0].toUpperCase();target.append(span)}}
function setUser(user){currentUser=user;authView.classList.add('hidden');welcome.classList.remove('hidden');nameInput.value=user.username;paintAvatar($('profileButton'),user.avatar,user.username);if(pendingInvite){const code=pendingInvite;pendingInvite=null;setTimeout(()=>connect(code),250)}}
function showAuth(){currentUser=null;welcome.classList.add('hidden');roomView.classList.add('hidden');authView.classList.remove('hidden')}
function randomCode(){return Array.from({length:4},()=> 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random()*32)]).join('')}
function send(data){if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(data))}
function addPerson(id,name,isSelf=false){
  peerNames.set(id,name);const card=document.createElement('div');card.className='person';card.id=`person-${id}`;
  const av=document.createElement('div');av.className='person-avatar';av.textContent=(name[0]||'M').toUpperCase();av.style.background=`linear-gradient(145deg,${palette[Math.abs([...name].reduce((a,c)=>a+c.charCodeAt(0),0))%palette.length]},#252a25)`;
  const nm=document.createElement('span');nm.className='person-name';nm.textContent=isSelf?`${name} (sen)`:name;
  const meta=document.createElement('span');meta.className='person-meta';meta.textContent=isSelf?'Bu cihaz':'Bağlanıyor…';
  const mic=document.createElement('span');mic.className='person-mic';mic.textContent=isSelf?'♩':'◌';
  card.append(av,nm,meta,mic);$('people').append(card);updateCount();return card;
}
function updateCount(){$('peopleCount').textContent=`${peerNames.size} ${peerNames.size===1?'kişi':'kişi'} odada`}
function removePerson(id){document.getElementById(`person-${id}`)?.remove();peerNames.delete(id);connections.get(id)?.close();connections.delete(id);livePeers.get(id)?.close();livePeers.delete(id);updateCount()}
async function connect(room,createRoom=false){
  if(!currentUser){showAuth();toast('Devam etmek için hesabına giriş yap.');return}
  const name=currentUser.username;
  try{localStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false})}
  catch(e){toast(e.name==='NotAllowedError'?'Mikrofon izni gerekli.':'Mikrofonuna erişemedim.');return}
  roomCode=room.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,8);if(!roomCode){localStream.getTracks().forEach(t=>t.stop());toast('Bir oda kodu yaz.');return}
  $('initial').textContent=name[0].toUpperCase();$('roomCode').textContent=roomCode;roomInput.value=roomCode;
  welcome.classList.add('hidden');roomView.classList.remove('hidden');$('people').innerHTML='';peerNames.clear();
  socket=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}`);
  socket.onopen=()=>send({type:'join',room:roomCode,name,create:createRoom});
  socket.onerror=()=>toast('Sunucuya bağlanılamadı.');
  socket.onclose=()=>{if(!roomView.classList.contains('hidden'))toast('Bağlantı kesildi. Yeniden katılmayı deneyebilirsin.')};
  socket.onmessage=async event=>{const m=JSON.parse(event.data);
    if(m.type==='error'){toast(m.message);socket.close();localStream?.getTracks().forEach(t=>t.stop());localStream=null;roomView.classList.add('hidden');welcome.classList.remove('hidden');return}
    // The newcomer waits for existing room members to initiate. This avoids
    // both peers creating offers at once (WebRTC offer glare).
    if(m.type==='joined'){myId=m.id;addPerson(myId,name,true);for(const p of m.peers)addPerson(p.id,p.name);if(m.live){liveBroadcaster=m.live.id;showLiveStage(m.live.name);send({type:'live-viewer-join'})}}
    if(m.type==='peer-joined'){addPerson(m.id,m.name);await createOffer(m.id)}
    if(m.type==='offer'){const pc=connections.get(m.from)||makePeer(m.from);await pc.setRemoteDescription(m.sdp);for(const c of pc.pendingCandidates.splice(0))try{await pc.addIceCandidate(c)}catch{}const answer=await pc.createAnswer();await pc.setLocalDescription(answer);send({type:'answer',to:m.from,sdp:pc.localDescription})}
    if(m.type==='answer'){const pc=connections.get(m.from);if(pc){await pc.setRemoteDescription(m.sdp);for(const c of pc.pendingCandidates.splice(0))try{await pc.addIceCandidate(c)}catch{}}}
    if(m.type==='candidate'){const pc=connections.get(m.from);if(pc){try{if(pc.remoteDescription)await pc.addIceCandidate(m.candidate);else pc.pendingCandidates.push(m.candidate)}catch{}}}
    if(m.type==='peer-left')removePerson(m.id);
    if(m.type==='mute'){const card=document.getElementById(`person-${m.from}`);if(card){card.querySelector('.person-meta').textContent=m.muted?'Mikrofon kapalı':'Bağlı';card.querySelector('.person-mic').textContent=m.muted?'⊘':'♩'}}
    if(m.type==='live-start'){liveBroadcaster=m.id;showLiveStage(m.name);send({type:'live-viewer-join'})}
    if(m.type==='live-viewer-join'&&liveStream)await offerLive(m.from)
    if(m.type==='live-offer')await answerLive(m)
    if(m.type==='live-answer'){const pc=livePeers.get(m.from);if(pc){await pc.setRemoteDescription(m.sdp);for(const c of pc.pendingCandidates.splice(0))try{await pc.addIceCandidate(c)}catch{}}}
    if(m.type==='live-candidate'){const pc=livePeers.get(m.from);if(pc){try{if(pc.remoteDescription)await pc.addIceCandidate(m.candidate);else pc.pendingCandidates.push(m.candidate)}catch{}}}
    if(m.type==='live-stop')stopLive(false)
    if(m.type==='live-error'){stopLive(false);toast(m.message)}
  };
}
function makePeer(id){
  const pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}]});pc.pendingCandidates=[];connections.set(id,pc);
  localStream.getTracks().forEach(track=>pc.addTrack(track,localStream));
  pc.onicecandidate=e=>{if(e.candidate)send({type:'candidate',to:id,candidate:e.candidate})};
  pc.ontrack=e=>{let audio=document.getElementById(`audio-${id}`);if(!audio){audio=document.createElement('audio');audio.id=`audio-${id}`;audio.autoplay=true;document.body.append(audio)}audio.srcObject=e.streams[0];audio.play().catch(()=>{});const c=document.getElementById(`person-${id}`);if(c)c.querySelector('.person-meta').textContent='Bağlı';startMeter(e.streams[0],id)};
  pc.onconnectionstatechange=()=>{if(pc.connectionState==='connected'){const c=document.getElementById(`person-${id}`);if(c)c.querySelector('.person-meta').textContent='Bağlı'}};
  return pc;
}
async function createOffer(id){const pc=makePeer(id);const offer=await pc.createOffer();await pc.setLocalDescription(offer);send({type:'offer',to:id,sdp:pc.localDescription})}
function showLiveStage(name){$('liveStage').classList.remove('hidden');$('liveName').textContent=name+' yayın yapıyor';$('broadcastLabel').textContent=liveStream?'Yayındasın':'Canlı yayını izle'}
function makeLivePeer(id){const pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}]});pc.pendingCandidates=[];livePeers.set(id,pc);pc.onicecandidate=e=>{if(e.candidate)send({type:'live-candidate',to:id,candidate:e.candidate})};pc.ontrack=e=>{$('liveVideo').srcObject=e.streams[0];$('liveVideo').play().catch(()=>{})};pc.onconnectionstatechange=()=>{if(['failed','closed','disconnected'].includes(pc.connectionState)){pc.close();livePeers.delete(id)}};return pc}
async function offerLive(id){const pc=makeLivePeer(id);liveStream.getVideoTracks().forEach(track=>pc.addTrack(track,liveStream));const offer=await pc.createOffer();await pc.setLocalDescription(offer);send({type:'live-offer',to:id,sdp:pc.localDescription})}
async function answerLive(m){const pc=makeLivePeer(m.from);await pc.setRemoteDescription(m.sdp);for(const c of pc.pendingCandidates.splice(0))try{await pc.addIceCandidate(c)}catch{}const answer=await pc.createAnswer();await pc.setLocalDescription(answer);send({type:'live-answer',to:m.from,sdp:pc.localDescription})}
async function startLive(){try{liveStream=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:1280},height:{ideal:720},facingMode:'user'},audio:false});$('liveVideo').srcObject=liveStream;$('liveName').textContent='Yayının';$('liveStage').classList.remove('hidden');$('stopLive').classList.remove('hidden');$('broadcastLabel').textContent='Yayını bitir';$('broadcast').classList.add('active');liveStream.getVideoTracks()[0].onended=()=>stopLive(true);send({type:'live-start'});toast('Canlı yayın başladı.')}catch(e){toast(e.name==='NotAllowedError'?'Kamera izni vermen gerekiyor.':'Kamera açılamadı.')}}
function stopLive(notify=true){if(notify&&liveStream)send({type:'live-stop'});liveStream?.getTracks().forEach(t=>t.stop());liveStream=null;livePeers.forEach(pc=>pc.close());livePeers.clear();liveBroadcaster=null;$('liveVideo').srcObject=null;$('liveStage').classList.add('hidden');$('stopLive').classList.add('hidden');$('broadcast').classList.remove('active');$('broadcastLabel').textContent='Yayına başla'}
function startMeter(stream,id){try{const ctx=new AudioContext(),src=ctx.createMediaStreamSource(stream),a=ctx.createAnalyser();a.fftSize=256;src.connect(a);const data=new Uint8Array(a.frequencyBinCount);const tick=()=>{a.getByteFrequencyData(data);let sum=0;for(const n of data)sum+=n;const c=document.getElementById(`person-${id}`);if(c)c.classList.toggle('talking',sum/data.length>20);if(!roomView.classList.contains('hidden'))requestAnimationFrame(tick);else ctx.close()};tick()}catch{}}
$('create').onclick=()=>{roomInput.value=randomCode();connect(roomInput.value,true)};
$('broadcast').onclick=()=>liveStream?stopLive(true):liveBroadcaster?toast('Bu odada zaten bir canlı yayın var.'):startLive();$('stopLive').onclick=()=>stopLive(true);
$('join').onclick=()=>connect(roomInput.value);
roomInput.addEventListener('keydown',e=>{if(e.key==='Enter')connect(roomInput.value)});
$('mute').onclick=()=>{muted=!muted;localStream?.getAudioTracks().forEach(t=>t.enabled=!muted);$('mute').classList.toggle('active',muted);$('muteLabel').textContent=muted?'Mikrofonu aç':'Mikrofonu kapat';send({type:'mute',muted});const c=document.getElementById(`person-${myId}`);if(c){c.querySelector('.person-meta').textContent=muted?'Mikrofon kapalı':'Bu cihaz';c.querySelector('.person-mic').textContent=muted?'⊘':'♩'}};
async function copy(text){try{await navigator.clipboard.writeText(text);toast('Kopyalandı, arkadaşlarınla paylaşabilirsin.')}catch{toast(`Oda kodu: ${roomCode}`)}}
$('copy').onclick=()=>copy(`${location.origin}/?room=${roomCode}`);$('copyCode').onclick=()=>copy(roomCode);
$('leave').onclick=()=>{stopLive(true);socket?.close();connections.forEach(pc=>pc.close());connections.clear();localStream?.getTracks().forEach(t=>t.stop());document.querySelectorAll('audio[id^="audio-"]').forEach(a=>a.remove());roomView.classList.add('hidden');welcome.classList.remove('hidden');muted=false;$('mute').classList.remove('active');$('muteLabel').textContent='Mikrofonu kapat'};
$('showRegister').onclick=()=>{ $('showRegister').classList.add('selected');$('showLogin').classList.remove('selected');$('verifyForm').classList.add('hidden');$('registerForm').classList.remove('hidden');$('loginForm').classList.add('hidden') };
$('showLogin').onclick=()=>{ $('showLogin').classList.add('selected');$('showRegister').classList.remove('selected');$('verifyForm').classList.add('hidden');$('loginForm').classList.remove('hidden');$('registerForm').classList.add('hidden') };
function showVerification(email,sent=true){verificationEmail=email;$('verifyCopy').textContent=sent?`${email} adresine 6 haneli bir kod gönderdik. Gelen kutunu ve spam klasörünü kontrol et.`:`${email} için kod kısa süre önce gönderildi. Gelen kutunu ve spam klasörünü kontrol et veya yeniden gönder.`;$('verificationCode').value='';$('registerForm').classList.add('hidden');$('loginForm').classList.add('hidden');$('verifyForm').classList.remove('hidden');$('verificationCode').focus()}
$('registerForm').onsubmit=async e=>{e.preventDefault();try{const result=await api('/api/register','POST',{username:$('registerUsername').value,email:$('registerEmail').value,password:$('registerPassword').value});showVerification(result.email);toast('E-postanı kontrol et.')}catch(err){toast(err.message)}};
$('loginForm').onsubmit=async e=>{e.preventDefault();try{const result=await api('/api/login','POST',{email:$('loginEmail').value,password:$('loginPassword').value});setUser(result.user);toast('Giriş yaptın.')}catch(err){if(err.needsVerification)showVerification(err.email,err.codeSent!==false);toast(err.message)}};
$('verifyForm').onsubmit=async e=>{e.preventDefault();try{const result=await api('/api/verify-email','POST',{email:verificationEmail,code:$('verificationCode').value});setUser(result.user);toast('E-posta doğrulandı, hoş geldin!')}catch(err){toast(err.message)}};
$('resendCode').onclick=async()=>{try{await api('/api/resend-code','POST',{email:verificationEmail});toast('Yeni doğrulama kodu gönderildi.')}catch(err){toast(err.message)}};
$('changeEmail').onclick=()=>{$('verifyForm').classList.add('hidden');$('registerForm').classList.remove('hidden');$('showRegister').classList.add('selected');$('showLogin').classList.remove('selected')};
$('profileButton').onclick=()=>{if(!currentUser)return;$('profileUsername').value=currentUser.username;avatarData=currentUser.avatar;profileAvatarChanged=false;paintAvatar($('profilePhotoPreview'),avatarData,currentUser.username);$('profileModal').classList.remove('hidden')};
$('closeProfile').onclick=()=>$('profileModal').classList.add('hidden');
$('avatarFile').onchange=async e=>{const file=e.target.files[0];if(!file)return;if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>512*1024){toast('PNG, JPG veya WebP fotoğraf seç; dosya en fazla 512 KB olsun.');e.target.value='';return}const reader=new FileReader();reader.onload=()=>{avatarData=reader.result;profileAvatarChanged=true;paintAvatar($('profilePhotoPreview'),avatarData,currentUser.username)};reader.readAsDataURL(file)};
$('profileForm').onsubmit=async e=>{e.preventDefault();try{const body={username:$('profileUsername').value};if(profileAvatarChanged)body.avatar=avatarData;const result=await api('/api/profile','PATCH',body);setUser(result.user);$('profileModal').classList.add('hidden');toast('Profilin güncellendi.')}catch(err){toast(err.message)}};
$('logout').onclick=async()=>{try{await api('/api/logout','POST',{})}catch{}socket?.close();connections.forEach(pc=>pc.close());connections.clear();localStream?.getTracks().forEach(t=>t.stop());localStream=null;$('profileModal').classList.add('hidden');showAuth();toast('Çıkış yaptın.')};
api('/api/me').then(result=>setUser(result.user)).catch(()=>showAuth());


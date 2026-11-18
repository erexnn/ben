const $ = id => document.getElementById(id);
const welcome = $('welcome'), roomView = $('roomView'), roomInput = $('room'), nameInput = $('name');
let socket, localStream, roomCode, myId, muted = false, connections = new Map(), peerNames = new Map(), audioContext, analyser, meterFrame;
const palette = ['#384936','#454039','#3c4542','#4b3b3b','#3d3a4d','#4b4939'];
function toast(text){const el=$('toast');el.textContent=text;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2400)}
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
function removePerson(id){document.getElementById(`person-${id}`)?.remove();peerNames.delete(id);connections.get(id)?.close();connections.delete(id);updateCount()}
async function connect(room,createRoom=false){
  const name=nameInput.value.trim()||'Misafir';
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
    if(m.type==='joined'){myId=m.id;addPerson(myId,name,true);for(const p of m.peers)addPerson(p.id,p.name)}
    if(m.type==='peer-joined'){addPerson(m.id,m.name);await createOffer(m.id)}
    if(m.type==='offer'){const pc=connections.get(m.from)||makePeer(m.from);await pc.setRemoteDescription(m.sdp);for(const c of pc.pendingCandidates.splice(0))try{await pc.addIceCandidate(c)}catch{}const answer=await pc.createAnswer();await pc.setLocalDescription(answer);send({type:'answer',to:m.from,sdp:pc.localDescription})}
    if(m.type==='answer'){const pc=connections.get(m.from);if(pc){await pc.setRemoteDescription(m.sdp);for(const c of pc.pendingCandidates.splice(0))try{await pc.addIceCandidate(c)}catch{}}}
    if(m.type==='candidate'){const pc=connections.get(m.from);if(pc){try{if(pc.remoteDescription)await pc.addIceCandidate(m.candidate);else pc.pendingCandidates.push(m.candidate)}catch{}}}
    if(m.type==='peer-left')removePerson(m.id);
    if(m.type==='mute'){const card=document.getElementById(`person-${m.from}`);if(card){card.querySelector('.person-meta').textContent=m.muted?'Mikrofon kapalı':'Bağlı';card.querySelector('.person-mic').textContent=m.muted?'⊘':'♩'}}
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
function startMeter(stream,id){try{const ctx=new AudioContext(),src=ctx.createMediaStreamSource(stream),a=ctx.createAnalyser();a.fftSize=256;src.connect(a);const data=new Uint8Array(a.frequencyBinCount);const tick=()=>{a.getByteFrequencyData(data);let sum=0;for(const n of data)sum+=n;const c=document.getElementById(`person-${id}`);if(c)c.classList.toggle('talking',sum/data.length>20);if(!roomView.classList.contains('hidden'))requestAnimationFrame(tick);else ctx.close()};tick()}catch{}}
$('create').onclick=()=>{roomInput.value=randomCode();connect(roomInput.value,true)};
$('join').onclick=()=>connect(roomInput.value);
roomInput.addEventListener('keydown',e=>{if(e.key==='Enter')connect(roomInput.value)});
nameInput.addEventListener('input',()=>{$('initial').textContent=(nameInput.value.trim()[0]||'M').toUpperCase()});
$('mute').onclick=()=>{muted=!muted;localStream?.getAudioTracks().forEach(t=>t.enabled=!muted);$('mute').classList.toggle('active',muted);$('muteLabel').textContent=muted?'Mikrofonu aç':'Mikrofonu kapat';send({type:'mute',muted});const c=document.getElementById(`person-${myId}`);if(c){c.querySelector('.person-meta').textContent=muted?'Mikrofon kapalı':'Bu cihaz';c.querySelector('.person-mic').textContent=muted?'⊘':'♩'}};
async function copy(text){try{await navigator.clipboard.writeText(text);toast('Kopyalandı, arkadaşlarınla paylaşabilirsin.')}catch{toast(`Oda kodu: ${roomCode}`)}}
$('copy').onclick=()=>copy(`${location.origin}/?room=${roomCode}`);$('copyCode').onclick=()=>copy(roomCode);
$('leave').onclick=()=>{socket?.close();connections.forEach(pc=>pc.close());connections.clear();localStream?.getTracks().forEach(t=>t.stop());document.querySelectorAll('audio[id^="audio-"]').forEach(a=>a.remove());roomView.classList.add('hidden');welcome.classList.remove('hidden');muted=false;$('mute').classList.remove('active');$('muteLabel').textContent='Mikrofonu kapat'};
const invite=new URLSearchParams(location.search).get('room');if(invite){roomInput.value=invite;setTimeout(()=>connect(invite),250)}


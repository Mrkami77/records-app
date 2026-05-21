// Simple JWT
async function generateToken(user) {
  return btoa(`${user.id}|${user.username}|${Date.now()}`);
}

async function verifyToken(token) {
  try {
    const decoded = atob(token);
    const [userId, username] = decoded.split('|');
    return { id: parseInt(userId), username };
  } catch {
    return null;
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const publicPaths = ['/api/auth/login', '/api/auth/register', '/'];
    let user = null;
    let isPublic = false;

    for (const p of publicPaths) {
      if (path === p) { isPublic = true; break; }
    }

    if (!isPublic) {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      user = await verifyToken(authHeader.split(' ')[1]);
      if (!user) {
        return new Response(JSON.stringify({ error: 'Invalid token' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    if (path === '/') return serveHTML();
    if (path === '/api/auth/register' && method === 'POST') return handleRegister(request, env);
    if (path === '/api/auth/login' && method === 'POST') return handleLogin(request, env);
    if (path === '/api/messages' && method === 'GET') {
      const roomId = url.searchParams.get('room') || 'general';
      return getMessages(env, roomId);
    }
    if (path === '/api/messages' && method === 'POST') return sendMessage(request, env, user);
    if (path === '/api/rooms' && method === 'GET') return getRooms(env);

    return new Response(JSON.stringify({ error: 'Not Found' }),
      { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  },
};

async function handleRegister(request, env) {
  try {
    const { username, email, password } = await request.json();
    if (!username || !email || !password) {
      return new Response(JSON.stringify({ error: 'All fields required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const hash = btoa(password + 'salt');
    try {
      await env.DB.prepare(
        `INSERT INTO users (username, email, password_hash, status, last_seen) VALUES (?, ?, ?, 'online', CURRENT_TIMESTAMP)`
      ).bind(username, email, hash).run();
      const user = await env.DB.prepare(`SELECT id, username FROM users WHERE username = ?`).bind(username).first();
      const token = await generateToken(user);
      return new Response(JSON.stringify({ success: true, token, user }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Username already exists' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

async function handleLogin(request, env) {
  try {
    const { username, password } = await request.json();
    const hash = btoa(password + 'salt');
    const user = await env.DB.prepare(
      `SELECT id, username FROM users WHERE username = ? AND password_hash = ?`
    ).bind(username, hash).first();
    if (!user) {
      return new Response(JSON.stringify({ error: 'Invalid credentials' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    await env.DB.prepare(`UPDATE users SET status = 'online', last_seen = CURRENT_TIMESTAMP WHERE id = ?`).bind(user.id).run();
    const token = await generateToken(user);
    return new Response(JSON.stringify({ success: true, token, user }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

async function getMessages(env, roomId) {
  try {
    const messages = await env.DB.prepare(
      `SELECT id, user_id, username, message, created_at FROM messages WHERE room_id = ? ORDER BY created_at ASC LIMIT 100`
    ).bind(roomId).all();
    return new Response(JSON.stringify(messages.results || []),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify([]),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

async function sendMessage(request, env, user) {
  try {
    const { roomId, message } = await request.json();
    if (!message || message.trim() === '') {
      return new Response(JSON.stringify({ error: 'Message cannot be empty' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    await env.DB.prepare(
      `INSERT INTO messages (room_id, user_id, username, message) VALUES (?, ?, ?, ?)`
    ).bind(roomId, user.id, user.username, message).run();
    return new Response(JSON.stringify({ success: true }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

async function getRooms(env) {
  try {
    const rooms = await env.DB.prepare(`SELECT id, name FROM rooms ORDER BY name`).all();
    return new Response(JSON.stringify(rooms.results || []),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify([]),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

function serveHTML() {
  return new Response(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Chat</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Google Sans',Arial,sans-serif;background:#131314;color:#e3e3e3;height:100vh;display:flex;overflow:hidden}

.sidebar{width:280px;background:#1e1f20;display:flex;flex-direction:column;border-right:1px solid #2d2e30;flex-shrink:0}
.sidebar-top{padding:16px 12px 8px}
.logo{display:flex;align-items:center;gap:10px;padding:12px 16px;margin-bottom:8px}
.logo-icon{width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#8ab4f8,#c58af9);display:flex;align-items:center;justify-content:center;font-size:16px}
.logo-text{font-size:18px;font-weight:500;color:#e3e3e3}
.new-chat-btn{display:flex;align-items:center;gap:10px;padding:10px 14px;border:1px solid #3c4043;border-radius:24px;cursor:pointer;font-size:14px;color:#c4c7c5;background:transparent;width:100%;margin-bottom:4px;transition:background 0.15s}
.new-chat-btn:hover{background:#2d2e30}
.sidebar-section{padding:8px 12px 4px;font-size:12px;color:#9aa0a6;letter-spacing:0.4px;font-weight:500}
.history-list{flex:1;overflow-y:auto;padding:0 8px}
.history-list::-webkit-scrollbar{width:4px}
.history-list::-webkit-scrollbar-thumb{background:#3c4043;border-radius:2px}
.history-item{padding:10px 14px;border-radius:12px;cursor:pointer;font-size:14px;color:#c4c7c5;transition:background 0.15s;margin:1px 0}
.history-item:hover{background:#2d2e30}
.history-item.active{background:#2d2e30;color:#e3e3e3}
.item-label{font-size:12px;color:#9aa0a6;margin-bottom:2px}
.item-text{font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sidebar-bottom{padding:12px 8px;border-top:1px solid #2d2e30}
.user-profile{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:12px;cursor:pointer;transition:background 0.15s}
.user-profile:hover{background:#2d2e30}
.user-avatar{width:32px;height:32px;border-radius:50%;background:#3c4043;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:500;color:#e3e3e3;flex-shrink:0}
.user-info{flex:1;min-width:0}
.user-name{font-size:14px;color:#e3e3e3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.user-email{font-size:12px;color:#9aa0a6}
.logout-btn{background:none;border:none;color:#9aa0a6;cursor:pointer;padding:4px;border-radius:6px;font-size:18px;line-height:1}
.logout-btn:hover{color:#e3e3e3}

.main{flex:1;display:flex;flex-direction:column;overflow:hidden}
.login-wrap{flex:1;display:flex;align-items:center;justify-content:center}
.login-card{background:#1e1f20;border:1px solid #2d2e30;border-radius:24px;padding:40px;width:380px}
.login-header{text-align:center;margin-bottom:28px}
.gem-icon{width:48px;height:48px;border-radius:50%;background:linear-gradient(135deg,#8ab4f8,#c58af9);margin:0 auto 12px;display:flex;align-items:center;justify-content:center;font-size:24px}
.login-header h2{font-size:24px;font-weight:400;color:#e3e3e3;margin-bottom:6px}
.login-header p{font-size:14px;color:#9aa0a6}
.form-group{margin-bottom:14px}
.form-input{width:100%;padding:12px 16px;background:#131314;border:1px solid #3c4043;border-radius:12px;font-size:14px;color:#e3e3e3;outline:none;transition:border-color 0.15s}
.form-input:focus{border-color:#8ab4f8}
.form-input::placeholder{color:#9aa0a6}
.login-btn{width:100%;padding:12px;background:#8ab4f8;color:#131314;border:none;border-radius:12px;font-size:15px;font-weight:500;cursor:pointer;margin-top:6px;transition:background 0.15s}
.login-btn:hover{background:#a8c7fa}
.switch-text{text-align:center;margin-top:16px;font-size:13px;color:#9aa0a6}
.switch-text a{color:#8ab4f8;cursor:pointer;text-decoration:none}

.chat-area{display:none;flex:1;flex-direction:column;overflow:hidden}
.room-header{padding:16px 24px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #2d2e30}
.room-icon{width:36px;height:36px;border-radius:10px;background:#2d2e30;display:flex;align-items:center;justify-content:center;font-size:16px}
.room-info h2{font-size:16px;font-weight:500;color:#e3e3e3}
.room-info p{font-size:12px;color:#9aa0a6}
.room-tabs{display:flex;gap:4px;margin-left:auto}
.room-tab{padding:6px 14px;border-radius:20px;cursor:pointer;font-size:13px;color:#9aa0a6;border:none;background:transparent;transition:all 0.15s}
.room-tab.active{background:#2d2e30;color:#e3e3e3}
.room-tab:hover{background:#2d2e30}

.messages-area{flex:1;overflow-y:auto;padding:20px 0}
.messages-area::-webkit-scrollbar{width:4px}
.messages-area::-webkit-scrollbar-thumb{background:#3c4043;border-radius:2px}
.msg-row{display:flex;gap:12px;padding:8px 24px;max-width:880px;margin:0 auto;width:100%}
.msg-row.own{flex-direction:row-reverse}
.msg-avatar{width:32px;height:32px;border-radius:50%;background:#3c4043;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:500;flex-shrink:0;align-self:flex-end}
.msg-avatar.own-av{background:linear-gradient(135deg,#8ab4f8,#c58af9);color:#131314}
.msg-content{max-width:72%}
.msg-name{font-size:12px;color:#9aa0a6;margin-bottom:4px;padding:0 4px}
.msg-row.own .msg-name{text-align:right}
.msg-bubble{padding:12px 16px;border-radius:18px;font-size:14px;line-height:1.5;word-break:break-word}
.msg-bubble.other{background:#2d2e30;color:#e3e3e3;border-bottom-left-radius:4px}
.msg-bubble.own{background:#1a3a5c;color:#e3e3e3;border-bottom-right-radius:4px}
.msg-time{font-size:11px;color:#9aa0a6;margin-top:4px;padding:0 4px}
.msg-row.own .msg-time{text-align:right}
.empty-state{text-align:center;padding:80px 40px;color:#5f6368}
.empty-icon{font-size:48px;margin-bottom:12px}
.empty-state h3{font-size:18px;font-weight:400;color:#9aa0a6;margin-bottom:6px}
.empty-state p{font-size:13px}

.input-section{padding:16px 24px 20px;max-width:880px;margin:0 auto;width:100%}
.input-container{background:#1e1f20;border:1px solid #3c4043;border-radius:24px;display:flex;align-items:flex-end;gap:8px;padding:8px 8px 8px 16px;transition:border-color 0.15s}
.input-container:focus-within{border-color:#8ab4f8}
.msg-input{flex:1;background:transparent;border:none;outline:none;color:#e3e3e3;font-size:14px;resize:none;max-height:120px;padding:6px 0;font-family:inherit;line-height:1.5}
.msg-input::placeholder{color:#9aa0a6}
.send-btn{width:40px;height:40px;border-radius:50%;background:#8ab4f8;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background 0.15s;opacity:0.4}
.send-btn.active{opacity:1}
.send-btn:hover{background:#a8c7fa}
.send-btn svg{fill:#131314}
.input-hint{text-align:center;font-size:11px;color:#5f6368;margin-top:10px}
</style>
</head>
<body>

<div class="sidebar" id="sidebar">
  <div class="sidebar-top">
    <div class="logo">
      <div class="logo-icon">&#10022;</div>
      <span class="logo-text">Chat</span>
    </div>
    <button class="new-chat-btn" onclick="newChat()">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      New chat
    </button>
  </div>

  <div class="history-list" id="historyList">
    <div class="sidebar-section">Rooms</div>
    <div id="roomsList"></div>
    <div class="sidebar-section" style="margin-top:8px">Recent</div>
    <div id="chatHistory"></div>
  </div>

  <div class="sidebar-bottom">
    <div class="user-profile" id="userProfile" style="display:none">
      <div class="user-avatar" id="userAvatarSidebar">?</div>
      <div class="user-info">
        <div class="user-name" id="userNameSidebar">User</div>
      </div>
      <button class="logout-btn" onclick="logout()" title="Sign out">&#x21AA;</button>
    </div>
  </div>
</div>

<div class="main">
  <div class="login-wrap" id="loginPage">
    <div class="login-card">
      <div class="login-header">
        <div class="gem-icon">&#10022;</div>
        <h2 id="formTitle">Sign in</h2>
        <p id="formSubtitle">to continue to Chat</p>
      </div>
      <div class="form-group"><input class="form-input" type="text" id="username" placeholder="Username"></div>
      <div class="form-group"><input class="form-input" type="password" id="password" placeholder="Password"></div>
      <div class="form-group" id="emailGroup" style="display:none"><input class="form-input" type="email" id="email" placeholder="Email"></div>
      <button class="login-btn" onclick="handleAuth()" id="submitBtn">Continue</button>
      <div class="switch-text">
        <span id="switchText">New here? </span><a id="switchLink" onclick="toggleMode()">Create account</a>
      </div>
    </div>
  </div>

  <div class="chat-area" id="chatArea">
    <div class="room-header">
      <div class="room-icon" id="roomIcon">#</div>
      <div class="room-info">
        <h2 id="currentRoomName">general</h2>
        <p id="roomSubtitle">Public room</p>
      </div>
      <div class="room-tabs" id="roomTabsContainer"></div>
    </div>

    <div class="messages-area" id="messagesArea">
      <div class="empty-state">
        <div class="empty-icon">&#128172;</div>
        <h3>Start the conversation</h3>
        <p>Say hello to the room!</p>
      </div>
    </div>

    <div class="input-section">
      <div class="input-container">
        <textarea class="msg-input" id="msgInput" placeholder="Message general..." rows="1"
          oninput="autoResize(this);toggleSend(this)"
          onkeydown="handleKey(event)"></textarea>
        <button class="send-btn" id="sendBtn" onclick="sendMessage()">
          <svg width="18" height="18" viewBox="0 0 24 24"><path d="M2 21l21-9L2 3v7l15 2-15 2v7z"/></svg>
        </button>
      </div>
      <div class="input-hint">Messages are visible to room participants</div>
    </div>
  </div>
</div>

<script>
let currentUser=null,currentRoom='general',token=null,refreshInterval=null,isLoginMode=true;

function toggleMode(){
  isLoginMode=!isLoginMode;
  document.getElementById('formTitle').textContent=isLoginMode?'Sign in':'Create account';
  document.getElementById('formSubtitle').textContent=isLoginMode?'to continue to Chat':'Join Chat';
  document.getElementById('emailGroup').style.display=isLoginMode?'none':'block';
  document.getElementById('submitBtn').textContent=isLoginMode?'Continue':'Create account';
  document.getElementById('switchText').textContent=isLoginMode?'New here? ':'Already have one? ';
  document.getElementById('switchLink').textContent=isLoginMode?'Create account':'Sign in';
}

async function handleAuth(){
  const u=document.getElementById('username').value.trim();
  const p=document.getElementById('password').value;
  if(!u||!p){alert('Please fill required fields');return;}
  if(isLoginMode){await doLogin(u,p);}
  else{
    const e=document.getElementById('email').value;
    if(!e||!e.includes('@')){alert('Valid email required');return;}
    await doRegister(u,e,p);
  }
}

async function doLogin(username,password){
  try{
    const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
    const d=await r.json();
    if(d.success){token=d.token;currentUser=d.user;localStorage.setItem('token',token);localStorage.setItem('user',JSON.stringify(currentUser));startChat();}
    else alert('Login failed: '+d.error);
  }catch(e){alert('Error: '+e.message);}
}

async function doRegister(username,email,password){
  try{
    const r=await fetch('/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,email,password})});
    const d=await r.json();
    if(d.success){token=d.token;currentUser=d.user;localStorage.setItem('token',token);localStorage.setItem('user',JSON.stringify(currentUser));startChat();}
    else alert('Registration failed: '+d.error);
  }catch(e){alert('Error: '+e.message);}
}

async function startChat(){
  document.getElementById('loginPage').style.display='none';
  const ca=document.getElementById('chatArea');
  ca.style.display='flex';ca.style.flexDirection='column';
  const profile=document.getElementById('userProfile');
  profile.style.display='flex';
  document.getElementById('userAvatarSidebar').textContent=(currentUser.username||'?').charAt(0).toUpperCase();
  document.getElementById('userNameSidebar').textContent=currentUser.username;
  await loadRooms();
  await loadMessages();
  addToHistory(currentRoom,'general');
  if(refreshInterval)clearInterval(refreshInterval);
  refreshInterval=setInterval(loadMessages,2500);
}

async function loadRooms(){
  try{
    const r=await fetch('/api/rooms',{headers:{'Authorization':'Bearer '+token}});
    const rooms=await r.json();
    const container=document.getElementById('roomsList');
    const tabs=document.getElementById('roomTabsContainer');
    container.innerHTML='';tabs.innerHTML='';
    rooms.forEach(room=>{
      const div=document.createElement('div');
      div.className='history-item'+(room.id===currentRoom?' active':'');
      div.innerHTML='<div class="item-text"># '+room.name+'</div>';
      div.onclick=()=>switchRoom(room.id,room.name,div);
      container.appendChild(div);
      const tab=document.createElement('button');
      tab.className='room-tab'+(room.id===currentRoom?' active':'');
      tab.textContent='#'+room.name;
      tab.onclick=()=>switchRoom(room.id,room.name,div);
      tabs.appendChild(tab);
    });
    if(rooms.length===0)container.innerHTML='<div style="padding:10px 14px;color:#5f6368;font-size:13px">No rooms</div>';
  }catch(e){console.error(e);}
}

function switchRoom(id,name,el){
  currentRoom=id;
  document.getElementById('currentRoomName').textContent=name;
  document.getElementById('msgInput').placeholder='Message '+name+'...';
  document.getElementById('roomIcon').textContent='#';
  document.querySelectorAll('.history-item').forEach(x=>x.classList.remove('active'));
  document.querySelectorAll('.room-tab').forEach(x=>x.classList.remove('active'));
  if(el){el.classList.add('active');}
  addToHistory(id,name);
  loadMessages();
}

function addToHistory(roomId,roomName){
  let h=JSON.parse(localStorage.getItem('chat_history')||'[]');
  h=h.filter(x=>x.id!==roomId);
  h.unshift({id:roomId,name:roomName||roomId,time:Date.now()});
  h=h.slice(0,8);
  localStorage.setItem('chat_history',JSON.stringify(h));
  renderHistory(h);
}

function renderHistory(h){
  const container=document.getElementById('chatHistory');
  container.innerHTML='';
  if(!h||h.length===0){container.innerHTML='<div style="padding:10px 14px;color:#5f6368;font-size:13px">No recent chats</div>';return;}
  h.forEach(item=>{
    const div=document.createElement('div');
    div.className='history-item'+(item.id===currentRoom?' active':'');
    const t=new Date(item.time);
    const label=t.toLocaleDateString(undefined,{month:'short',day:'numeric'});
    div.innerHTML='<div class="item-label">'+label+'</div><div class="item-text"># '+(item.name||item.id)+'</div>';
    div.onclick=()=>switchRoom(item.id,item.name||item.id,div);
    container.appendChild(div);
  });
}

async function loadMessages(){
  try{
    const r=await fetch('/api/messages?room='+currentRoom,{headers:{'Authorization':'Bearer '+token}});
    const msgs=await r.json();
    const area=document.getElementById('messagesArea');
    const wasBottom=area.scrollHeight-area.scrollTop-area.clientHeight<60;
    if(!msgs||msgs.length===0){
      area.innerHTML='<div class="empty-state"><div class="empty-icon">&#128172;</div><h3>Start the conversation</h3><p>Be the first to say something!</p></div>';
      return;
    }
    area.innerHTML='';
    let lastUser=null;
    msgs.forEach(msg=>{
      const isOwn=msg.user_id===currentUser.id;
      const showName=msg.username!==lastUser;
      lastUser=msg.username;
      const row=document.createElement('div');
      row.className='msg-row'+(isOwn?' own':'');
      const av=document.createElement('div');
      av.className='msg-avatar'+(isOwn?' own-av':'');
      av.textContent=(msg.username||'?').charAt(0).toUpperCase();
      const content=document.createElement('div');
      content.className='msg-content';
      if(showName){const n=document.createElement('div');n.className='msg-name';n.textContent=msg.username;content.appendChild(n);}
      const bubble=document.createElement('div');
      bubble.className='msg-bubble '+(isOwn?'own':'other');
      bubble.textContent=msg.message;
      const time=document.createElement('div');
      time.className='msg-time';
      time.textContent=new Date(msg.created_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
      content.appendChild(bubble);
      content.appendChild(time);
      row.appendChild(av);
      row.appendChild(content);
      area.appendChild(row);
    });
    if(wasBottom)area.scrollTop=area.scrollHeight;
  }catch(e){console.error(e);}
}

async function sendMessage(){
  const input=document.getElementById('msgInput');
  const message=input.value.trim();
  if(!message)return;
  try{
    await fetch('/api/messages',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({roomId:currentRoom,message})});
    input.value='';
    input.style.height='auto';
    document.getElementById('sendBtn').classList.remove('active');
    await loadMessages();
    document.getElementById('messagesArea').scrollTop=document.getElementById('messagesArea').scrollHeight;
  }catch(e){console.error(e);}
}

function handleKey(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();}}
function autoResize(el){el.style.height='auto';el.style.height=Math.min(el.scrollHeight,120)+'px';}
function toggleSend(el){document.getElementById('sendBtn').classList.toggle('active',el.value.trim().length>0);}
function newChat(){document.getElementById('messagesArea').innerHTML='<div class="empty-state"><div class="empty-icon">&#128172;</div><h3>Select a room</h3><p>Choose a room from the sidebar</p></div>';}
function logout(){localStorage.clear();if(refreshInterval)clearInterval(refreshInterval);location.reload();}

const savedToken=localStorage.getItem('token');
const savedUser=localStorage.getItem('user');
if(savedToken&&savedUser){token=savedToken;currentUser=JSON.parse(savedUser);startChat();}
const h=JSON.parse(localStorage.getItem('chat_history')||'[]');
if(h.length>0)renderHistory(h);
</script>
</body>
</html>`, { headers: { 'Content-Type': 'text/html' } });
}
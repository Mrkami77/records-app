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

// PASTE YOUR REAL GEMINI API KEY BELOW (no dashes in the middle)
const GEMINI_API_KEY = 'AIzaSyB1IGc325RpPvllmA2S78DrleHHOS9nc';

async function getGeminiReply(userMessage, roomName) {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `You are a helpful AI assistant in a chat room called "${roomName}". Reply concisely and helpfully to: ${userMessage}`
            }]
          }]
        })
      }
    );
    const data = await res.json();

    // If there's an API error, return it as a visible message so you can debug
    if (data.error) {
      return `[Gemini error: ${data.error.message}]`;
    }

    return data?.candidates?.[0]?.content?.parts?.[0]?.text || '[Gemini returned no reply]';
  } catch (e) {
    return `[Gemini fetch failed: ${e.message}]`;
  }
}

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

    // Save user message
    await env.DB.prepare(
      `INSERT INTO messages (room_id, user_id, username, message) VALUES (?, ?, ?, ?)`
    ).bind(roomId, user.id, user.username, message).run();

    // Get room name for context
    let roomName = roomId;
    try {
      const room = await env.DB.prepare(`SELECT name FROM rooms WHERE id = ?`).bind(roomId).first();
      if (room) roomName = room.name;
    } catch(e) {}

    // Get Gemini AI reply
    const aiReply = await getGeminiReply(message, roomName);
    if (aiReply) {
      await env.DB.prepare(
        `INSERT INTO messages (room_id, user_id, username, message) VALUES (?, ?, ?, ?)`
      ).bind(roomId, 0, 'Gemini AI', aiReply).run();
    }

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
body{font-family:'Google Sans',Arial,sans-serif;background:#1a1b1e;color:#e3e3e3;height:100vh;display:flex;overflow:hidden}

/* ── Sidebar ── */
.sidebar{width:280px;background:#25262b;display:flex;flex-direction:column;flex-shrink:0}
.logo{display:flex;align-items:center;gap:10px;padding:20px 20px 12px}
.logo-gem{width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,#8ab4f8,#c58af9);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0}
.logo-text{font-size:20px;font-weight:500;color:#e3e3e3}
.new-chat-btn{display:flex;align-items:center;gap:10px;margin:0 12px 8px;padding:10px 16px;border:1px solid #3a3b40;border-radius:24px;cursor:pointer;font-size:14px;color:#c4c7c5;background:transparent;width:calc(100% - 24px);transition:background .15s}
.new-chat-btn:hover{background:#2e2f35}
.sidebar-section{padding:10px 20px 4px;font-size:11px;color:#9aa0a6;letter-spacing:.8px;font-weight:600;text-transform:uppercase}
.nav-list{padding:0 8px}
.nav-item{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;cursor:pointer;font-size:14px;color:#c4c7c5;transition:background .15s;margin:1px 0}
.nav-item:hover{background:#2e2f35}
.nav-item.active{background:#2e2f35;color:#e3e3e3}
.nav-item .nav-hash{color:#8ab4f8;font-weight:600;font-size:16px;width:18px;text-align:center}
.history-section{flex:1;overflow-y:auto;padding:0 8px}
.history-section::-webkit-scrollbar{width:3px}
.history-section::-webkit-scrollbar-thumb{background:#3a3b40;border-radius:2px}
.hist-item{padding:8px 12px;border-radius:10px;cursor:pointer;margin:1px 0;transition:background .15s}
.hist-item:hover{background:#2e2f35}
.hist-item.active{background:#2e2f35}
.hist-date{font-size:11px;color:#9aa0a6;margin-bottom:2px}
.hist-name{font-size:13px;color:#c4c7c5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sidebar-footer{padding:8px 8px 12px;border-top:1px solid #2e2f35}
.user-row{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;cursor:pointer;transition:background .15s}
.user-row:hover{background:#2e2f35}
.u-avatar{width:32px;height:32px;border-radius:50%;background:#3a3b40;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;color:#e3e3e3;flex-shrink:0}
.u-name{flex:1;font-size:14px;color:#e3e3e3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.logout-btn{background:none;border:none;color:#9aa0a6;cursor:pointer;font-size:20px;padding:2px 4px;border-radius:6px;line-height:1;transition:color .15s}
.logout-btn:hover{color:#e3e3e3}

/* ── Main ── */
.main{flex:1;display:flex;flex-direction:column;overflow:hidden;background:#1a1b1e}

/* ── Login ── */
.login-wrap{flex:1;display:flex;align-items:center;justify-content:center;background:#1a1b1e}
.login-card{background:#25262b;border:1px solid #3a3b40;border-radius:24px;padding:44px 40px;width:380px}
.lc-header{text-align:center;margin-bottom:32px}
.lc-gem{width:52px;height:52px;border-radius:50%;background:linear-gradient(135deg,#8ab4f8,#c58af9);margin:0 auto 14px;display:flex;align-items:center;justify-content:center;font-size:26px}
.lc-header h2{font-size:26px;font-weight:400;color:#e3e3e3;margin-bottom:6px}
.lc-header p{font-size:14px;color:#9aa0a6}
.fi{width:100%;padding:13px 16px;background:#1a1b1e;border:1px solid #3a3b40;border-radius:12px;font-size:14px;color:#e3e3e3;outline:none;transition:border-color .15s;margin-bottom:12px}
.fi:focus{border-color:#8ab4f8}
.fi::placeholder{color:#9aa0a6}
.lb{width:100%;padding:13px;background:#8ab4f8;color:#131314;border:none;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer;margin-top:4px;transition:background .15s}
.lb:hover{background:#a8c7fa}
.sw{text-align:center;margin-top:18px;font-size:13px;color:#9aa0a6}
.sw a{color:#8ab4f8;cursor:pointer}

/* ── Chat ── */
.chat-area{display:none;flex:1;flex-direction:column;overflow:hidden}

/* header */
.room-header{padding:14px 24px;display:flex;align-items:center;gap:12px;background:#25262b;border-bottom:1px solid #2e2f35}
.rh-icon{width:36px;height:36px;border-radius:10px;background:#2e2f35;display:flex;align-items:center;justify-content:center;font-size:16px;color:#8ab4f8;font-weight:700}
.rh-info h2{font-size:16px;font-weight:500;color:#e3e3e3}
.rh-info p{font-size:12px;color:#9aa0a6}
.rh-tabs{display:flex;gap:4px;margin-left:auto;flex-wrap:wrap}
.rh-tab{padding:6px 14px;border-radius:20px;cursor:pointer;font-size:13px;color:#9aa0a6;border:none;background:transparent;transition:all .15s}
.rh-tab.active,.rh-tab:hover{background:#2e2f35;color:#e3e3e3}

/* messages */
.msgs{flex:1;overflow-y:auto;padding:24px 0;background:#1a1b1e}
.msgs::-webkit-scrollbar{width:4px}
.msgs::-webkit-scrollbar-thumb{background:#3a3b40;border-radius:2px}
.msg-row{display:flex;gap:12px;padding:4px 28px;max-width:900px;margin:0 auto;width:100%}
.msg-row.own{flex-direction:row-reverse}
.m-av{width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;flex-shrink:0;align-self:flex-end}
.m-av.other-av{background:#3a3b40;color:#e3e3e3}
.m-av.own-av{background:linear-gradient(135deg,#8ab4f8,#c58af9);color:#131314}
.m-av.ai-av{background:linear-gradient(135deg,#34a853,#4285f4);color:#fff}
.m-content{max-width:68%}
.m-name{font-size:12px;color:#9aa0a6;margin-bottom:4px;padding:0 4px}
.msg-row.own .m-name{text-align:right}
.m-bubble{padding:12px 16px;border-radius:18px;font-size:14px;line-height:1.6;word-break:break-word;white-space:pre-wrap}
.m-bubble.other{background:#2e2f35;color:#e3e3e3;border-bottom-left-radius:4px}
.m-bubble.own{background:#1d3a5f;color:#e3e3e3;border-bottom-right-radius:4px}
.m-bubble.ai{background:#1e3a2e;color:#e3e3e3;border-bottom-left-radius:4px;border-left:2px solid #34a853}
.m-time{font-size:11px;color:#9aa0a6;margin-top:4px;padding:0 4px}
.msg-row.own .m-time{text-align:right}
.empty-state{text-align:center;padding:100px 40px;color:#5f6368}
.es-icon{font-size:52px;margin-bottom:14px}
.empty-state h3{font-size:18px;font-weight:400;color:#9aa0a6;margin-bottom:6px}
.empty-state p{font-size:13px;color:#5f6368}

/* typing indicator */
.typing-row{display:flex;gap:12px;padding:4px 28px;max-width:900px;margin:0 auto;width:100%}
.typing-bubble{padding:12px 18px;background:#2e2f35;border-radius:18px;border-bottom-left-radius:4px;display:flex;align-items:center;gap:4px}
.dot{width:7px;height:7px;border-radius:50%;background:#9aa0a6;animation:bounce 1.2s infinite}
.dot:nth-child(2){animation-delay:.2s}
.dot:nth-child(3){animation-delay:.4s}
@keyframes bounce{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-6px)}}

/* input */
.input-wrap{padding:14px 28px 20px;max-width:900px;margin:0 auto;width:100%;background:#1a1b1e}
.input-box{background:#25262b;border:1px solid #3a3b40;border-radius:24px;display:flex;align-items:flex-end;gap:8px;padding:8px 8px 8px 18px;transition:border-color .15s}
.input-box:focus-within{border-color:#8ab4f8}
.msg-ta{flex:1;background:transparent;border:none;outline:none;color:#e3e3e3;font-size:14px;resize:none;max-height:140px;padding:6px 0;font-family:inherit;line-height:1.5}
.msg-ta::placeholder{color:#9aa0a6}
.send-btn{width:42px;height:42px;border-radius:50%;background:#8ab4f8;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .15s;opacity:.35}
.send-btn.on{opacity:1}
.send-btn:hover.on{background:#a8c7fa}
.send-btn svg{fill:#131314}
.input-hint{text-align:center;font-size:11px;color:#5f6368;margin-top:8px}
</style>
</head>
<body>

<!-- SIDEBAR -->
<div class="sidebar" id="sidebar">
  <div class="logo">
    <div class="logo-gem">&#10022;</div>
    <span class="logo-text">Chat</span>
  </div>
  <button class="new-chat-btn" onclick="newChat()">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    New chat
  </button>

  <div class="sidebar-section">Rooms</div>
  <div class="nav-list" id="roomsList"></div>

  <div class="sidebar-section" style="margin-top:4px">Recent</div>
  <div class="history-section" id="historyList"></div>

  <div class="sidebar-footer">
    <div class="user-row" id="userRow" style="display:none">
      <div class="u-avatar" id="uAvatar">?</div>
      <div class="u-name" id="uName">User</div>
      <button class="logout-btn" onclick="logout()" title="Sign out">&#x21AA;</button>
    </div>
  </div>
</div>

<!-- MAIN -->
<div class="main">

  <!-- LOGIN -->
  <div class="login-wrap" id="loginPage">
    <div class="login-card">
      <div class="lc-header">
        <div class="lc-gem">&#10022;</div>
        <h2 id="formTitle">Sign in</h2>
        <p id="formSubtitle">to continue to Chat</p>
      </div>
      <input class="fi" type="text" id="username" placeholder="Username">
      <input class="fi" type="password" id="password" placeholder="Password">
      <div id="emailWrap" style="display:none"><input class="fi" type="email" id="email" placeholder="Email"></div>
      <button class="lb" id="submitBtn" onclick="handleAuth()">Continue</button>
      <div class="sw">
        <span id="swText">New here? </span><a id="swLink" onclick="toggleMode()">Create account</a>
      </div>
    </div>
  </div>

  <!-- CHAT -->
  <div class="chat-area" id="chatArea">
    <div class="room-header">
      <div class="rh-icon" id="roomIcon">#</div>
      <div class="rh-info">
        <h2 id="curRoomName">General Chat</h2>
        <p>Public room &bull; AI-powered</p>
      </div>
      <div class="rh-tabs" id="rhTabs"></div>
    </div>

    <div class="msgs" id="msgs">
      <div class="empty-state">
        <div class="es-icon">&#10022;</div>
        <h3>Ask Gemini anything</h3>
        <p>Send a message and Gemini AI will reply</p>
      </div>
    </div>

    <div class="input-wrap">
      <div class="input-box">
        <textarea class="msg-ta" id="msgTa" placeholder="Message Gemini..." rows="1"
          oninput="autoResize(this);toggleSend(this)"
          onkeydown="handleKey(event)"></textarea>
        <button class="send-btn" id="sendBtn" onclick="sendMsg()">
          <svg width="18" height="18" viewBox="0 0 24 24"><path d="M2 21l21-9L2 3v7l15 2-15 2v7z"/></svg>
        </button>
      </div>
      <div class="input-hint">Gemini AI replies to every message</div>
    </div>
  </div>
</div>

<script>
let currentUser=null,currentRoom='general',currentRoomName='General Chat',token=null,refreshInterval=null,isLogin=true,sending=false;

function toggleMode(){
  isLogin=!isLogin;
  document.getElementById('formTitle').textContent=isLogin?'Sign in':'Create account';
  document.getElementById('formSubtitle').textContent=isLogin?'to continue to Chat':'Join the conversation';
  document.getElementById('emailWrap').style.display=isLogin?'none':'block';
  document.getElementById('submitBtn').textContent=isLogin?'Continue':'Create account';
  document.getElementById('swText').textContent=isLogin?'New here? ':'Have an account? ';
  document.getElementById('swLink').textContent=isLogin?'Create account':'Sign in';
}

async function handleAuth(){
  const u=document.getElementById('username').value.trim();
  const p=document.getElementById('password').value;
  if(!u||!p){alert('Please fill all fields');return;}
  if(isLogin){await doLogin(u,p);}
  else{
    const e=document.getElementById('email').value;
    if(!e||!e.includes('@')){alert('Enter a valid email');return;}
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
  const ca=document.getElementById('chatArea');ca.style.display='flex';ca.style.flexDirection='column';
  document.getElementById('userRow').style.display='flex';
  document.getElementById('uAvatar').textContent=(currentUser.username||'?').charAt(0).toUpperCase();
  document.getElementById('uName').textContent=currentUser.username;
  await loadRooms();
  await loadMessages();
  addHistory(currentRoom,currentRoomName);
  if(refreshInterval)clearInterval(refreshInterval);
  refreshInterval=setInterval(loadMessages,3000);
}

async function loadRooms(){
  try{
    const r=await fetch('/api/rooms',{headers:{'Authorization':'Bearer '+token}});
    const rooms=await r.json();
    const nl=document.getElementById('roomsList');
    const tabs=document.getElementById('rhTabs');
    nl.innerHTML='';tabs.innerHTML='';
    rooms.forEach(room=>{
      const div=document.createElement('div');
      div.className='nav-item'+(room.id===currentRoom?' active':'');
      div.innerHTML='<span class="nav-hash">#</span><span>'+escHtml(room.name)+'</span>';
      div.onclick=()=>switchRoom(room.id,room.name);
      nl.appendChild(div);
      const tab=document.createElement('button');
      tab.className='rh-tab'+(room.id===currentRoom?' active':'');
      tab.textContent='#'+room.name;
      tab.onclick=()=>switchRoom(room.id,room.name);
      tabs.appendChild(tab);
    });
    if(!rooms.length)nl.innerHTML='<div style="padding:10px 12px;color:#5f6368;font-size:13px">No rooms</div>';
  }catch(e){console.error(e);}
}

function switchRoom(id,name){
  currentRoom=id;currentRoomName=name;
  document.getElementById('curRoomName').textContent=name;
  document.getElementById('msgTa').placeholder='Message '+name+'...';
  document.querySelectorAll('.nav-item').forEach(x=>x.classList.remove('active'));
  document.querySelectorAll('.rh-tab').forEach(x=>x.classList.remove('active'));
  addHistory(id,name);
  loadMessages();
}

function addHistory(id,name){
  let h=JSON.parse(localStorage.getItem('ch')||'[]');
  h=h.filter(x=>x.id!==id);
  h.unshift({id,name,t:Date.now()});
  h=h.slice(0,10);
  localStorage.setItem('ch',JSON.stringify(h));
  renderHistory(h);
}

function renderHistory(h){
  const c=document.getElementById('historyList');
  c.innerHTML='';
  if(!h||!h.length){c.innerHTML='<div style="padding:10px 12px;color:#5f6368;font-size:13px">No recent chats</div>';return;}
  h.forEach(item=>{
    const div=document.createElement('div');
    div.className='hist-item'+(item.id===currentRoom?' active':'');
    const d=new Date(item.t);
    const lbl=d.toLocaleDateString(undefined,{month:'short',day:'numeric'});
    div.innerHTML='<div class="hist-date">'+lbl+'</div><div class="hist-name"># '+escHtml(item.name||item.id)+'</div>';
    div.onclick=()=>switchRoom(item.id,item.name||item.id);
    c.appendChild(div);
  });
}

async function loadMessages(){
  try{
    const r=await fetch('/api/messages?room='+currentRoom,{headers:{'Authorization':'Bearer '+token}});
    const msgs=await r.json();
    const area=document.getElementById('msgs');
    const atBottom=area.scrollHeight-area.scrollTop-area.clientHeight<80;
    if(!msgs||!msgs.length){
      area.innerHTML='<div class="empty-state"><div class="es-icon">&#10022;</div><h3>Ask Gemini anything</h3><p>Send a message and Gemini AI will reply</p></div>';
      return;
    }
    // Remove typing indicator if present before re-render
    area.innerHTML='';
    let lastUser=null;
    msgs.forEach(msg=>{
      const isOwn=msg.user_id===currentUser.id;
      const isAI=msg.username==='Gemini AI';
      const showName=msg.username!==lastUser;
      lastUser=msg.username;
      const row=document.createElement('div');
      row.className='msg-row'+(isOwn?' own':'');
      const av=document.createElement('div');
      av.className='m-av '+(isOwn?'own-av':isAI?'ai-av':'other-av');
      av.textContent=isAI?'G':(msg.username||'?').charAt(0).toUpperCase();
      const content=document.createElement('div');content.className='m-content';
      if(showName){const n=document.createElement('div');n.className='m-name';n.textContent=isAI?'Gemini AI':msg.username;content.appendChild(n);}
      const bubble=document.createElement('div');
      bubble.className='m-bubble '+(isOwn?'own':isAI?'ai':'other');
      bubble.textContent=msg.message;
      const time=document.createElement('div');time.className='m-time';
      time.textContent=new Date(msg.created_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
      content.appendChild(bubble);content.appendChild(time);
      row.appendChild(av);row.appendChild(content);
      area.appendChild(row);
    });
    if(atBottom||sending)area.scrollTop=area.scrollHeight;
  }catch(e){console.error(e);}
}

function showTyping(){
  const area=document.getElementById('msgs');
  const row=document.createElement('div');
  row.className='typing-row';row.id='typingRow';
  const av=document.createElement('div');av.className='m-av ai-av';av.textContent='G';
  const bubble=document.createElement('div');bubble.className='typing-bubble';
  bubble.innerHTML='<div class="dot"></div><div class="dot"></div><div class="dot"></div>';
  row.appendChild(av);row.appendChild(bubble);
  area.appendChild(row);
  area.scrollTop=area.scrollHeight;
}

function hideTyping(){
  const t=document.getElementById('typingRow');
  if(t)t.remove();
}

async function sendMsg(){
  if(sending)return;
  const ta=document.getElementById('msgTa');
  const message=ta.value.trim();
  if(!message)return;
  sending=true;
  ta.value='';ta.style.height='auto';
  document.getElementById('sendBtn').classList.remove('on');
  showTyping();
  try{
    await fetch('/api/messages',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({roomId:currentRoom,message})});
    await loadMessages();
  }catch(e){console.error(e);}finally{
    hideTyping();
    sending=false;
  }
}

function handleKey(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMsg();}}
function autoResize(el){el.style.height='auto';el.style.height=Math.min(el.scrollHeight,140)+'px';}
function toggleSend(el){document.getElementById('sendBtn').classList.toggle('on',el.value.trim().length>0);}
function newChat(){document.getElementById('msgs').innerHTML='<div class="empty-state"><div class="es-icon">&#10022;</div><h3>Ask Gemini anything</h3><p>Select a room to start</p></div>';}
function logout(){localStorage.clear();if(refreshInterval)clearInterval(refreshInterval);location.reload();}
function escHtml(s){if(!s)return'';return s.replace(/[&<>]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]));}

// Auto-login from saved session
const st=localStorage.getItem('token'),su=localStorage.getItem('user');
if(st&&su){token=st;currentUser=JSON.parse(su);startChat();}
const ch=JSON.parse(localStorage.getItem('ch')||'[]');
if(ch.length)renderHistory(ch);
</script>
</body>
</html>`, { headers: { 'Content-Type': 'text/html' } });
}

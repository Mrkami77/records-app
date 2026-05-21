// JWT utilities
async function generateToken(user) {
  const data = `${user.id}|${user.username}|${Date.now()}`;
  return btoa(data);
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
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const publicPaths = ['/api/auth/login', '/api/auth/register', '/api/health', '/'];
    
    let user = null;
    let isPublic = false;
    
    for (const publicPath of publicPaths) {
      if (path === publicPath) {
        isPublic = true;
        break;
      }
    }
    
    if (!isPublic) {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), 
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const token = authHeader.split(' ')[1];
      user = await verifyToken(token);
      if (!user) {
        return new Response(JSON.stringify({ error: 'Invalid token' }), 
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    if (path === '/' || path === '/index.html') {
      return serveHTML();
    }

    if (path === '/api/auth/register' && method === 'POST') {
      return handleRegister(request, env);
    }
    
    if (path === '/api/auth/login' && method === 'POST') {
      return handleLogin(request, env);
    }
    
    if (path === '/api/messages' && method === 'GET') {
      const roomId = url.searchParams.get('room') || 'general';
      const limit = parseInt(url.searchParams.get('limit')) || 50;
      return getMessages(env, roomId, limit);
    }
    
    if (path === '/api/messages' && method === 'POST') {
      return sendMessage(request, env, user);
    }
    
    if (path === '/api/rooms' && method === 'GET') {
      return getRooms(env);
    }
    
    if (path === '/api/users' && method === 'GET') {
      return getUsers(env);
    }
    
    if (path === '/api/health') {
      return new Response(JSON.stringify({ status: 'healthy', timestamp: new Date().toISOString() }), 
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

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
    
    const hash = btoa(password + 'cloudflare-salt');
    
    try {
      await env.DB.prepare(
        `INSERT INTO users (username, email, password_hash, status, last_seen) 
         VALUES (?, ?, ?, 'online', CURRENT_TIMESTAMP)`
      ).bind(username, email, hash).run();
      
      const user = await env.DB.prepare(
        `SELECT id, username, email FROM users WHERE username = ?`
      ).bind(username).first();
      
      const token = await generateToken(user);
      
      return new Response(JSON.stringify({ success: true, token, user }), 
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    } catch (err) {
      if (err.message.includes('UNIQUE')) {
        return new Response(JSON.stringify({ error: 'Username or email already exists' }), 
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      throw err;
    }
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), 
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

async function handleLogin(request, env) {
  try {
    const { username, password } = await request.json();
    const hash = btoa(password + 'cloudflare-salt');
    
    const user = await env.DB.prepare(
      `SELECT id, username, email, role FROM users 
       WHERE username = ? AND password_hash = ?`
    ).bind(username, hash).first();
    
    if (!user) {
      return new Response(JSON.stringify({ error: 'Invalid credentials' }), 
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    
    await env.DB.prepare(
      `UPDATE users SET status = 'online', last_seen = CURRENT_TIMESTAMP WHERE id = ?`
    ).bind(user.id).run();
    
    const token = await generateToken(user);
    
    return new Response(JSON.stringify({ success: true, token, user }), 
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), 
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

async function getMessages(env, roomId, limit) {
  try {
    const messages = await env.DB.prepare(
      `SELECT id, user_id, username, message, created_at 
       FROM messages 
       WHERE room_id = ? AND (is_deleted = 0 OR is_deleted IS NULL)
       ORDER BY created_at ASC LIMIT ?`
    ).bind(roomId, limit).all();
    
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
      `INSERT INTO messages (room_id, user_id, username, message) 
       VALUES (?, ?, ?, ?)`
    ).bind(roomId, user.id, user.username, message).run();
    
    const newMessage = await env.DB.prepare(
      `SELECT id, user_id, username, message, created_at 
       FROM messages WHERE id = last_insert_rowid()`
    ).first();
    
    return new Response(JSON.stringify({ success: true, message: newMessage }), 
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), 
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

async function getRooms(env) {
  try {
    const rooms = await env.DB.prepare(
      `SELECT id, name, type FROM rooms ORDER BY name`
    ).all();
    
    return new Response(JSON.stringify(rooms.results || []), 
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify([]), 
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

async function getUsers(env) {
  try {
    const users = await env.DB.prepare(
      `SELECT id, username, status FROM users ORDER BY username`
    ).all();
    
    return new Response(JSON.stringify(users.results || []), 
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify([]), 
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

function serveHTML() {
  return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Enterprise Pro Chat</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; height: 100vh; overflow: hidden; }
        
        .auth-container { display: flex; justify-content: center; align-items: center; height: 100vh; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
        .auth-card { background: white; border-radius: 24px; padding: 48px; width: 400px; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25); }
        .auth-card h2 { margin-bottom: 32px; text-align: center; background: linear-gradient(135deg, #667eea, #764ba2); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .input-group { margin-bottom: 20px; }
        .input-group input { width: 100%; padding: 12px 16px; border: 2px solid #e2e8f0; border-radius: 12px; font-size: 14px; }
        .input-group input:focus { outline: none; border-color: #6366f1; }
        .btn { width: 100%; padding: 12px; background: linear-gradient(135deg, #6366f1, #4f46e5); color: white; border: none; border-radius: 12px; font-size: 16px; font-weight: 600; cursor: pointer; }
        .auth-switch { text-align: center; margin-top: 20px; color: #666; }
        .auth-switch a { color: #6366f1; cursor: pointer; text-decoration: none; }
        
        .chat-container { display: none; height: 100vh; }
        .app-layout { display: flex; height: 100vh; }
        
        .sidebar { width: 260px; background: white; border-right: 1px solid #e2e8f0; display: flex; flex-direction: column; }
        .sidebar-header { padding: 24px; background: linear-gradient(135deg, #6366f1, #4f46e5); color: white; }
        .workspace-name { font-size: 18px; font-weight: 700; margin-bottom: 4px; }
        .workspace-desc { font-size: 12px; opacity: 0.8; }
        .nav-menu { flex: 1; padding: 16px; }
        .nav-section-title { font-size: 11px; font-weight: 600; text-transform: uppercase; color: #64748b; margin-bottom: 12px; padding: 0 12px; letter-spacing: 0.5px; }
        .room-item { padding: 10px 12px; margin: 4px 0; border-radius: 10px; cursor: pointer; display: flex; align-items: center; gap: 12px; color: #1e293b; transition: all 0.2s; }
        .room-item i { width: 20px; color: #64748b; }
        .room-item:hover { background: #f1f5f9; }
        .room-item.active { background: linear-gradient(135deg, #6366f1, #4f46e5); color: white; }
        .room-item.active i { color: white; }
        .logout-btn { margin: 16px; padding: 12px; background: #f1f5f9; border: none; border-radius: 10px; cursor: pointer; display: flex; align-items: center; gap: 10px; color: #1e293b; font-weight: 500; }
        .logout-btn:hover { background: #fee2e2; color: #dc2626; }
        
        .chat-main { flex: 1; display: flex; flex-direction: column; background: #fafbfc; }
        .chat-header { padding: 20px 24px; background: white; border-bottom: 1px solid #e2e8f0; }
        .current-room-name { font-size: 20px; font-weight: 700; color: #1e293b; }
        .room-meta { font-size: 13px; color: #64748b; margin-top: 4px; }
        
        .messages-area { flex: 1; overflow-y: auto; padding: 24px; display: flex; flex-direction: column; gap: 16px; }
        .message-group { display: flex; gap: 12px; animation: fadeIn 0.3s ease; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .message-avatar { width: 36px; height: 36px; border-radius: 10px; background: linear-gradient(135deg, #6366f1, #4f46e5); display: flex; align-items: center; justify-content: center; color: white; font-weight: 600; flex-shrink: 0; }
        .message-content { flex: 1; }
        .message-header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 6px; }
        .message-sender { font-weight: 700; color: #1e293b; font-size: 14px; }
        .message-time { font-size: 11px; color: #64748b; }
        .message-text { color: #1e293b; line-height: 1.5; font-size: 14px; background: white; padding: 10px 14px; border-radius: 12px; display: inline-block; max-width: 70%; box-shadow: 0 1px 2px rgba(0,0,0,0.05); }
        .message-own { flex-direction: row-reverse; }
        .message-own .message-text { background: linear-gradient(135deg, #6366f1, #4f46e5); color: white; }
        
        .chat-input-area { padding: 20px 24px; background: white; border-top: 1px solid #e2e8f0; }
        .input-wrapper { display: flex; gap: 12px; background: #f1f5f9; border-radius: 16px; padding: 12px 16px; }
        .chat-input { flex: 1; border: none; background: none; outline: none; font-size: 14px; font-family: inherit; }
        .send-btn { background: linear-gradient(135deg, #6366f1, #4f46e5); color: white; border: none; padding: 8px 20px; border-radius: 12px; cursor: pointer; font-weight: 600; }
        
        .right-sidebar { width: 240px; background: white; border-left: 1px solid #e2e8f0; display: flex; flex-direction: column; }
        .right-sidebar-header { padding: 20px; border-bottom: 1px solid #e2e8f0; font-weight: 600; color: #1e293b; }
        .users-list { flex: 1; overflow-y: auto; padding: 12px; }
        .user-item { display: flex; align-items: center; gap: 12px; padding: 10px 12px; margin: 4px 0; border-radius: 10px; }
        .user-avatar { width: 32px; height: 32px; border-radius: 8px; background: linear-gradient(135deg, #10b981, #059669); display: flex; align-items: center; justify-content: center; color: white; font-weight: 600; font-size: 12px; }
        .user-name { font-size: 14px; font-weight: 500; color: #1e293b; }
        .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #10b981; display: inline-block; margin-right: 6px; }
        .status-dot.offline { background: #94a3b8; }
        
        .empty-state { text-align: center; padding: 60px; color: #64748b; }
        .empty-state i { font-size: 48px; margin-bottom: 16px; opacity: 0.3; }
        
        @media (max-width: 768px) { .sidebar, .right-sidebar { display: none; } }
    </style>
</head>
<body>
    <div id="authContainer" class="auth-container">
        <div class="auth-card">
            <h2 id="authTitle">Welcome Back</h2>
            <div>
                <div class="input-group"><input type="text" id="loginUsername" placeholder="Username"></div>
                <div class="input-group"><input type="password" id="loginPassword" placeholder="Password"></div>
                <button class="btn" onclick="handleAuth()" id="authBtn">Sign In</button>
                <div class="auth-switch">New here? <a onclick="toggleAuth()">Create account</a></div>
            </div>
        </div>
    </div>

    <div id="chatContainer" class="chat-container">
        <div class="app-layout">
            <div class="sidebar">
                <div class="sidebar-header">
                    <div class="workspace-name">Enterprise Pro</div>
                    <div class="workspace-desc">Team Communication</div>
                </div>
                <div class="nav-menu">
                    <div class="nav-section-title">CHANNELS</div>
                    <div id="roomsList"></div>
                </div>
                <button class="logout-btn" onclick="logout()"><i class="fas fa-sign-out-alt"></i> Sign Out</button>
            </div>

            <div class="chat-main">
                <div class="chat-header">
                    <div class="current-room-name" id="currentRoomName">General Chat</div>
                    <div class="room-meta" id="roomMeta"># general-channel</div>
                </div>
                <div class="messages-area" id="messagesArea"></div>
                <div class="chat-input-area">
                    <div class="input-wrapper">
                        <textarea class="chat-input" id="messageInput" placeholder="Type your message..." rows="1" onkeypress="if(event.key==='Enter' && !event.shiftKey){ event.preventDefault(); sendMessage(); }"></textarea>
                        <button class="send-btn" onclick="sendMessage()"><i class="fas fa-paper-plane"></i> Send</button>
                    </div>
                </div>
            </div>

            <div class="right-sidebar">
                <div class="right-sidebar-header"><i class="fas fa-users"></i> Team Members</div>
                <div class="users-list" id="usersList"></div>
            </div>
        </div>
    </div>

    <script>
        let currentUser = null, currentRoom = 'general', token = null, messageInterval = null;

        async function handleAuth() {
            const isLogin = document.getElementById('authTitle').innerText === 'Welcome Back';
            const username = document.getElementById('loginUsername').value;
            const password = document.getElementById('loginPassword').value;
            if (!username || !password) { alert('Please enter username and password'); return; }
            if (isLogin) await login(username, password);
            else { const email = prompt('Enter your email:'); if (email) await register(username, email, password); }
        }

        async function login(username, password) {
            try {
                const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
                const data = await res.json();
                if (data.success) {
                    token = data.token; currentUser = data.user;
                    localStorage.setItem('token', token); localStorage.setItem('user', JSON.stringify(currentUser));
                    showChat(); loadMessages(); loadRooms(); loadUsers(); startPolling();
                } else alert('Login failed: ' + data.error);
            } catch (err) { alert('Error: ' + err.message); }
        }

        async function register(username, email, password) {
            try {
                const res = await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, email, password }) });
                const data = await res.json();
                if (data.success) {
                    token = data.token; currentUser = data.user;
                    localStorage.setItem('token', token); localStorage.setItem('user', JSON.stringify(currentUser));
                    showChat(); loadMessages(); loadRooms(); loadUsers(); startPolling();
                } else alert('Registration failed: ' + data.error);
            } catch (err) { alert('Error: ' + err.message); }
        }

        function toggleAuth() {
            const title = document.getElementById('authTitle'), btn = document.getElementById('authBtn'), switchText = document.querySelector('.auth-switch');
            if (title.innerText === 'Welcome Back') {
                title.innerText = 'Create Account'; btn.innerText = 'Sign Up';
                switchText.innerHTML = 'Already have an account? <a onclick="toggleAuth()">Sign In</a>';
            } else {
                title.innerText = 'Welcome Back'; btn.innerText = 'Sign In';
                switchText.innerHTML = 'New here? <a onclick="toggleAuth()">Create account</a>';
            }
        }

        function showChat() {
            document.getElementById('authContainer').style.display = 'none';
            document.getElementById('chatContainer').style.display = 'block';
        }

        async function loadMessages() {
            try {
                const res = await fetch('/api/messages?room=' + currentRoom + '&limit=50', { headers: { 'Authorization': 'Bearer ' + token } });
                const messages = await res.json();
                const messagesArea = document.getElementById('messagesArea');
                if (!messages || messages.length === 0) {
                    messagesArea.innerHTML = '<div class="empty-state"><i class="fas fa-comments"></i><br>No messages yet. Start the conversation!</div>';
                    return;
                }
                messagesArea.innerHTML = '';
                messages.forEach(msg => {
                    const div = document.createElement('div');
                    div.className = 'message-group ' + (msg.user_id === currentUser.id ? 'message-own' : '');
                    div.innerHTML = '<div class="message-avatar">' + (msg.username ? msg.username.charAt(0).toUpperCase() : '?') + '</div>' +
                        '<div class="message-content">' +
                            '<div class="message-header">' +
                                '<span class="message-sender">' + escapeHtml(msg.username) + '</span>' +
                                '<span class="message-time">' + new Date(msg.created_at).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) + '</span>' +
                            '</div>' +
                            '<div class="message-text">' + escapeHtml(msg.message) + '</div>' +
                        '</div>';
                    messagesArea.appendChild(div);
                });
                messagesArea.scrollTop = messagesArea.scrollHeight;
            } catch (err) { console.error(err); }
        }

        async function sendMessage() {
            const input = document.getElementById('messageInput');
            const message = input.value.trim();
            if (!message) return;
            try {
                const res = await fetch('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ roomId: currentRoom, message }) });
                if (res.ok) { input.value = ''; loadMessages(); }
            } catch (err) { console.error(err); }
        }

        async function loadRooms() {
            try {
                const res = await fetch('/api/rooms', { headers: { 'Authorization': 'Bearer ' + token } });
                const rooms = await res.json();
                const roomsList = document.getElementById('roomsList');
                roomsList.innerHTML = '';
                if (rooms && rooms.length > 0) {
                    rooms.forEach(room => {
                        const roomDiv = document.createElement('div');
                        roomDiv.className = 'room-item ' + (room.id === currentRoom ? 'active' : '');
                        roomDiv.innerHTML = '<i class="fas fa-hashtag"></i><span>' + escapeHtml(room.name) + '</span>';
                        roomDiv.onclick = () => { currentRoom = room.id; document.getElementById('currentRoomName').innerText = room.name; document.getElementById('roomMeta').innerHTML = '# ' + room.id + '-channel'; loadMessages(); loadRooms(); };
                        roomsList.appendChild(roomDiv);
                    });
                } else {
                    roomsList.innerHTML = '<div style="padding: 12px; color: #64748b;">No rooms found</div>';
                }
            } catch (err) { console.error('Load rooms error:', err); }
        }

        async function loadUsers() {
            try {
                const res = await fetch('/api/users', { headers: { 'Authorization': 'Bearer ' + token } });
                const users = await res.json();
                const usersList = document.getElementById('usersList');
                usersList.innerHTML = '';
                if (users && users.length > 0) {
                    users.forEach(user => {
                        if (user.id !== currentUser.id) {
                            const userDiv = document.createElement('div');
                            userDiv.className = 'user-item';
                            userDiv.innerHTML = '<div class="user-avatar">' + user.username.charAt(0).toUpperCase() + '</div>' +
                                '<div><div class="user-name">' + escapeHtml(user.username) + '</div>' +
                                '<div><span class="status-dot ' + (user.status === 'online' ? '' : 'offline') + '"></span>' + (user.status === 'online' ? 'Online' : 'Offline') + '</div></div>';
                            usersList.appendChild(userDiv);
                        }
                    });
                }
            } catch (err) { console.error(err); }
        }

        function startPolling() { if (messageInterval) clearInterval(messageInterval); messageInterval = setInterval(() => { if (currentUser) loadMessages(); }, 3000); }
        async function logout() { localStorage.removeItem('token'); localStorage.removeItem('user'); if (messageInterval) clearInterval(messageInterval); location.reload(); }
        function escapeHtml(str) { if (!str) return ''; return str.replace(/[&<>]/g, function(m) { if (m === '&') return '&amp;'; if (m === '<') return '&lt;'; if (m === '>') return '&gt;'; return m; }); }

        const savedToken = localStorage.getItem('token'), savedUser = localStorage.getItem('user');
        if (savedToken && savedUser) { token = savedToken; currentUser = JSON.parse(savedUser); showChat(); loadMessages(); loadRooms(); loadUsers(); startPolling(); }
    </script>
</body>
</html>`, { headers: { 'Content-Type': 'text/html' } });
}
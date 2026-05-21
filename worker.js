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

    // Public paths
    const publicPaths = ['/api/auth/login', '/api/auth/register', '/'];
    
    let user = null;
    let isPublic = false;
    
    for (const p of publicPaths) {
      if (path === p) {
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
      user = await verifyToken(authHeader.split(' ')[1]);
      if (!user) {
        return new Response(JSON.stringify({ error: 'Invalid token' }), 
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    // Routes
    if (path === '/') {
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
      return getMessages(env, roomId);
    }
    
    if (path === '/api/messages' && method === 'POST') {
      return sendMessage(request, env, user);
    }
    
    if (path === '/api/rooms' && method === 'GET') {
      return getRooms(env);
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
    
    const hash = btoa(password + 'salt');
    
    try {
      await env.DB.prepare(
        `INSERT INTO users (username, email, password_hash, status, last_seen) 
         VALUES (?, ?, ?, 'online', CURRENT_TIMESTAMP)`
      ).bind(username, email, hash).run();
      
      const user = await env.DB.prepare(
        `SELECT id, username FROM users WHERE username = ?`
      ).bind(username).first();
      
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

async function getMessages(env, roomId) {
  try {
    const messages = await env.DB.prepare(
      `SELECT id, user_id, username, message, created_at 
       FROM messages 
       WHERE room_id = ? 
       ORDER BY created_at ASC 
       LIMIT 100`
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
      `INSERT INTO messages (room_id, user_id, username, message) 
       VALUES (?, ?, ?, ?)`
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
    <title>Simple Chat</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            background: #0f172a;
            height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        /* Login Page */
        .login-container {
            background: white;
            border-radius: 16px;
            padding: 40px;
            width: 380px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
        }
        
        .login-container h2 {
            margin-bottom: 24px;
            color: #0f172a;
            text-align: center;
        }
        
        .login-container input {
            width: 100%;
            padding: 12px;
            margin-bottom: 16px;
            border: 1px solid #e2e8f0;
            border-radius: 8px;
            font-size: 14px;
        }
        
        .login-container input:focus {
            outline: none;
            border-color: #6366f1;
        }
        
        .login-container button {
            width: 100%;
            padding: 12px;
            background: #6366f1;
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
        }
        
        .login-container button:hover {
            background: #4f46e5;
        }
        
        .switch-btn {
            text-align: center;
            margin-top: 16px;
            color: #64748b;
        }
        
        .switch-btn a {
            color: #6366f1;
            cursor: pointer;
            text-decoration: none;
        }
        
        /* Chat App */
        .chat-app {
            display: none;
            width: 100%;
            height: 100vh;
            background: #f8fafc;
        }
        
        .chat-layout {
            display: flex;
            height: 100%;
        }
        
        /* Sidebar */
        .sidebar {
            width: 260px;
            background: white;
            border-right: 1px solid #e2e8f0;
            display: flex;
            flex-direction: column;
        }
        
        .sidebar-header {
            padding: 20px;
            background: #6366f1;
            color: white;
        }
        
        .sidebar-header h3 {
            margin-bottom: 4px;
        }
        
        .sidebar-header p {
            font-size: 12px;
            opacity: 0.8;
        }
        
        .rooms-list {
            flex: 1;
            padding: 16px;
        }
        
        .room {
            padding: 10px 12px;
            margin: 4px 0;
            border-radius: 8px;
            cursor: pointer;
            color: #1e293b;
            transition: all 0.2s;
        }
        
        .room:hover {
            background: #f1f5f9;
        }
        
        .room.active {
            background: #6366f1;
            color: white;
        }
        
        .logout {
            margin: 16px;
            padding: 10px;
            background: #f1f5f9;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            color: #1e293b;
            font-weight: 500;
        }
        
        .logout:hover {
            background: #fee2e2;
            color: #dc2626;
        }
        
        /* Chat Main */
        .chat-main {
            flex: 1;
            display: flex;
            flex-direction: column;
            background: #f8fafc;
        }
        
        .chat-header {
            padding: 20px;
            background: white;
            border-bottom: 1px solid #e2e8f0;
        }
        
        .chat-header h2 {
            font-size: 18px;
            color: #0f172a;
        }
        
        /* Messages */
        .messages {
            flex: 1;
            overflow-y: auto;
            padding: 20px;
            display: flex;
            flex-direction: column;
            gap: 12px;
        }
        
        .message {
            display: flex;
            gap: 10px;
            max-width: 70%;
        }
        
        .message-own {
            align-self: flex-end;
            flex-direction: row-reverse;
        }
        
        .message-avatar {
            width: 32px;
            height: 32px;
            border-radius: 8px;
            background: #6366f1;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-weight: 600;
            font-size: 14px;
            flex-shrink: 0;
        }
        
        .message-bubble {
            background: white;
            padding: 10px 14px;
            border-radius: 12px;
            box-shadow: 0 1px 2px rgba(0,0,0,0.05);
        }
        
        .message-own .message-bubble {
            background: #6366f1;
            color: white;
        }
        
        .message-name {
            font-size: 12px;
            font-weight: 600;
            margin-bottom: 4px;
            color: #6366f1;
        }
        
        .message-own .message-name {
            color: rgba(255,255,255,0.8);
        }
        
        .message-text {
            font-size: 14px;
            line-height: 1.4;
            word-wrap: break-word;
        }
        
        .message-time {
            font-size: 10px;
            margin-top: 4px;
            opacity: 0.6;
        }
        
        /* Input */
        .input-area {
            padding: 20px;
            background: white;
            border-top: 1px solid #e2e8f0;
        }
        
        .input-wrapper {
            display: flex;
            gap: 12px;
        }
        
        .input-wrapper input {
            flex: 1;
            padding: 12px;
            border: 1px solid #e2e8f0;
            border-radius: 24px;
            font-size: 14px;
        }
        
        .input-wrapper input:focus {
            outline: none;
            border-color: #6366f1;
        }
        
        .input-wrapper button {
            padding: 12px 24px;
            background: #6366f1;
            color: white;
            border: none;
            border-radius: 24px;
            cursor: pointer;
            font-weight: 600;
        }
        
        .input-wrapper button:hover {
            background: #4f46e5;
        }
        
        .empty {
            text-align: center;
            padding: 60px;
            color: #94a3b8;
        }
        
        @media (max-width: 768px) {
            .sidebar {
                width: 200px;
            }
            .message {
                max-width: 85%;
            }
        }
    </style>
</head>
<body>
    <!-- Login Page -->
    <div id="loginPage" class="login-container">
        <h2 id="formTitle">Welcome</h2>
        <input type="text" id="username" placeholder="Username">
        <input type="password" id="password" placeholder="Password">
        <input type="email" id="email" placeholder="Email" style="display: none;">
        <button id="submitBtn" onclick="handleAuth()">Login</button>
        <div class="switch-btn">
            <span id="switchText">New user? </span><a id="switchLink" onclick="toggleMode()">Create account</a>
        </div>
    </div>

    <!-- Chat App -->
    <div id="chatApp" class="chat-app">
        <div class="chat-layout">
            <div class="sidebar">
                <div class="sidebar-header">
                    <h3>Simple Chat</h3>
                    <p id="currentUserName">User</p>
                </div>
                <div class="rooms-list" id="roomsList"></div>
                <button class="logout" onclick="logout()">🚪 Sign Out</button>
            </div>
            <div class="chat-main">
                <div class="chat-header">
                    <h2 id="currentRoomName">General</h2>
                </div>
                <div class="messages" id="messages"></div>
                <div class="input-area">
                    <div class="input-wrapper">
                        <input type="text" id="messageInput" placeholder="Type a message..." onkeypress="if(event.key==='Enter') sendMessage()">
                        <button onclick="sendMessage()">Send</button>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script>
        let currentUser = null;
        let currentRoom = 'general';
        let token = null;
        let refreshInterval = null;

        function toggleMode() {
            const title = document.getElementById('formTitle');
            const emailField = document.getElementById('email');
            const btn = document.getElementById('submitBtn');
            const switchText = document.getElementById('switchText');
            const switchLink = document.getElementById('switchLink');
            
            if (title.innerText === 'Welcome') {
                title.innerText = 'Create Account';
                emailField.style.display = 'block';
                btn.innerText = 'Register';
                switchText.innerText = 'Already have an account? ';
                switchLink.innerText = 'Login';
            } else {
                title.innerText = 'Welcome';
                emailField.style.display = 'none';
                btn.innerText = 'Login';
                switchText.innerText = 'New user? ';
                switchLink.innerText = 'Create account';
            }
        }

        async function handleAuth() {
            const username = document.getElementById('username').value;
            const password = document.getElementById('password').value;
            
            if (!username || !password) {
                alert('Please fill all fields');
                return;
            }
            
            const isLogin = document.getElementById('formTitle').innerText === 'Welcome';
            
            if (isLogin) {
                await login(username, password);
            } else {
                const email = document.getElementById('email').value;
                if (!email || !email.includes('@')) {
                    alert('Please enter valid email');
                    return;
                }
                await register(username, email, password);
            }
        }

        async function login(username, password) {
            try {
                const res = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                const data = await res.json();
                if (data.success) {
                    token = data.token;
                    currentUser = data.user;
                    localStorage.setItem('token', token);
                    localStorage.setItem('user', JSON.stringify(currentUser));
                    startChat();
                } else {
                    alert('Login failed: ' + data.error);
                }
            } catch (err) {
                alert('Error: ' + err.message);
            }
        }

        async function register(username, email, password) {
            try {
                const res = await fetch('/api/auth/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, email, password })
                });
                const data = await res.json();
                if (data.success) {
                    token = data.token;
                    currentUser = data.user;
                    localStorage.setItem('token', token);
                    localStorage.setItem('user', JSON.stringify(currentUser));
                    startChat();
                } else {
                    alert('Registration failed: ' + data.error);
                }
            } catch (err) {
                alert('Error: ' + err.message);
            }
        }

        async function startChat() {
            document.getElementById('loginPage').style.display = 'none';
            document.getElementById('chatApp').style.display = 'block';
            document.getElementById('currentUserName').innerHTML = currentUser.username;
            await loadRooms();
            await loadMessages();
            if (refreshInterval) clearInterval(refreshInterval);
            refreshInterval = setInterval(() => loadMessages(), 2000);
        }

        async function loadRooms() {
            try {
                const res = await fetch('/api/rooms', {
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                const rooms = await res.json();
                const container = document.getElementById('roomsList');
                container.innerHTML = '';
                
                if (rooms.length === 0) {
                    container.innerHTML = '<div style="padding: 12px; color: #64748b;">No rooms</div>';
                    return;
                }
                
                rooms.forEach(room => {
                    const div = document.createElement('div');
                    div.className = 'room' + (room.id === currentRoom ? ' active' : '');
                    div.innerHTML = '#' + room.name;
                    div.onclick = () => {
                        currentRoom = room.id;
                        document.getElementById('currentRoomName').innerHTML = room.name;
                        loadMessages();
                        loadRooms();
                    };
                    container.appendChild(div);
                });
            } catch (err) {
                console.error(err);
            }
        }

        async function loadMessages() {
            try {
                const res = await fetch('/api/messages?room=' + currentRoom, {
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                const messages = await res.json();
                const container = document.getElementById('messages');
                
                if (!messages || messages.length === 0) {
                    container.innerHTML = '<div class="empty">💬 No messages yet. Say something!</div>';
                    return;
                }
                
                container.innerHTML = '';
                messages.forEach(msg => {
                    const isOwn = msg.user_id === currentUser.id;
                    const div = document.createElement('div');
                    div.className = 'message ' + (isOwn ? 'message-own' : '');
                    div.innerHTML = \`
                        <div class="message-avatar">\${msg.username ? msg.username.charAt(0).toUpperCase() : '?'}</div>
                        <div class="message-bubble">
                            <div class="message-name">\${escapeHtml(msg.username)}</div>
                            <div class="message-text">\${escapeHtml(msg.message)}</div>
                            <div class="message-time">\${new Date(msg.created_at).toLocaleTimeString()}</div>
                        </div>
                    \`;
                    container.appendChild(div);
                });
                container.scrollTop = container.scrollHeight;
            } catch (err) {
                console.error(err);
            }
        }

        async function sendMessage() {
            const input = document.getElementById('messageInput');
            const message = input.value.trim();
            if (!message) return;
            
            try {
                const res = await fetch('/api/messages', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + token
                    },
                    body: JSON.stringify({ roomId: currentRoom, message })
                });
                if (res.ok) {
                    input.value = '';
                    await loadMessages();
                }
            } catch (err) {
                console.error(err);
            }
        }

        function logout() {
            localStorage.clear();
            if (refreshInterval) clearInterval(refreshInterval);
            location.reload();
        }

        function escapeHtml(str) {
            if (!str) return '';
            return str.replace(/[&<>]/g, function(m) {
                if (m === '&') return '&amp;';
                if (m === '<') return '&lt;';
                if (m === '>') return '&gt;';
                return m;
            });
        }

        // Check saved session
        const savedToken = localStorage.getItem('token');
        const savedUser = localStorage.getItem('user');
        if (savedToken && savedUser) {
            token = savedToken;
            currentUser = JSON.parse(savedUser);
            startChat();
        }
    </script>
</body>
</html>`, { headers: { 'Content-Type': 'text/html' } });
}
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

// CORS headers
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

    // Handle CORS
    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Public paths (no auth required)
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

    // Routes
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
    
    // Simple hash (in production, use proper bcrypt)
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
      `SELECT id, user_id, username, message, message_type, file_url, created_at 
       FROM messages 
       WHERE room_id = ? AND (is_deleted = 0 OR is_deleted IS NULL)
       ORDER BY created_at DESC LIMIT ?`
    ).bind(roomId, limit).all();
    
    const reversedMessages = (messages.results || []).reverse();
    
    return new Response(JSON.stringify(reversedMessages), 
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message, messages: [] }), 
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

async function sendMessage(request, env, user) {
  try {
    const { roomId, message, messageType = 'text' } = await request.json();
    
    if (!message || message.trim() === '') {
      return new Response(JSON.stringify({ error: 'Message cannot be empty' }), 
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    
    await env.DB.prepare(
      `INSERT INTO messages (room_id, user_id, username, message, message_type) 
       VALUES (?, ?, ?, ?, ?)`
    ).bind(roomId, user.id, user.username, message, messageType).run();
    
    const newMessage = await env.DB.prepare(
      `SELECT id, user_id, username, message, message_type, created_at 
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
      `SELECT id, name, type, created_at FROM rooms ORDER BY name`
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
      `SELECT id, username, status, last_seen FROM users ORDER BY username`
    ).all();
    
    return new Response(JSON.stringify(users.results || []), 
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify([]), 
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

function serveHTML() {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Enterprise Chat - Professional Communication</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            height: 100vh;
            overflow: hidden;
        }
        .auth-container {
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
        }
        .auth-card {
            background: white;
            border-radius: 20px;
            padding: 40px;
            width: 400px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            animation: slideUp 0.5s ease;
        }
        @keyframes slideUp {
            from { opacity: 0; transform: translateY(50px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .auth-card h2 {
            margin-bottom: 30px;
            color: #333;
            text-align: center;
        }
        .input-group {
            margin-bottom: 20px;
        }
        .input-group input {
            width: 100%;
            padding: 12px 15px;
            border: 2px solid #e0e0e0;
            border-radius: 10px;
            font-size: 14px;
        }
        .input-group input:focus {
            outline: none;
            border-color: #667eea;
        }
        .btn {
            width: 100%;
            padding: 12px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            border-radius: 10px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
        }
        .btn:hover { transform: translateY(-2px); }
        .auth-switch {
            text-align: center;
            margin-top: 20px;
            color: #666;
        }
        .auth-switch a {
            color: #667eea;
            text-decoration: none;
            cursor: pointer;
        }
        .chat-container {
            display: none;
            height: 100vh;
            background: #f5f7fb;
        }
        .chat-sidebar {
            background: white;
            width: 280px;
            border-right: 1px solid #e0e0e0;
            display: flex;
            flex-direction: column;
        }
        .user-info {
            padding: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }
        .user-name { font-size: 18px; font-weight: 600; }
        .logout-btn {
            margin-top: 10px;
            background: rgba(255,255,255,0.2);
            border: 1px solid rgba(255,255,255,0.3);
            color: white;
            padding: 8px;
            border-radius: 8px;
            cursor: pointer;
            width: 100%;
        }
        .rooms-list {
            flex: 1;
            overflow-y: auto;
            padding: 10px;
        }
        .room-item {
            padding: 12px 15px;
            margin: 5px 0;
            border-radius: 10px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        .room-item:hover { background: #f0f0f0; }
        .room-item.active {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }
        .chat-main {
            flex: 1;
            display: flex;
            flex-direction: column;
        }
        .chat-header {
            background: white;
            padding: 20px;
            border-bottom: 1px solid #e0e0e0;
        }
        .current-room { font-size: 20px; font-weight: 600; color: #333; }
        .messages-area {
            flex: 1;
            overflow-y: auto;
            padding: 20px;
            display: flex;
            flex-direction: column;
            gap: 15px;
        }
        .message { display: flex; }
        .message-own { justify-content: flex-end; }
        .message-bubble {
            max-width: 60%;
            padding: 10px 15px;
            border-radius: 15px;
            background: white;
            box-shadow: 0 1px 2px rgba(0,0,0,0.1);
        }
        .message-own .message-bubble {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }
        .message-sender { font-size: 12px; font-weight: 600; margin-bottom: 5px; color: #667eea; }
        .message-time { font-size: 10px; margin-top: 5px; opacity: 0.7; text-align: right; }
        .chat-input-area {
            background: white;
            padding: 20px;
            border-top: 1px solid #e0e0e0;
            display: flex;
            gap: 10px;
        }
        .chat-input {
            flex: 1;
            padding: 12px;
            border: 2px solid #e0e0e0;
            border-radius: 10px;
        }
        .send-btn {
            padding: 12px 30px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            border-radius: 10px;
            cursor: pointer;
        }
        .users-list {
            width: 250px;
            background: white;
            border-left: 1px solid #e0e0e0;
            padding: 20px;
            overflow-y: auto;
        }
        .user-item {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 8px;
            margin: 5px 0;
        }
        .user-status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #4caf50;
        }
        .user-status-dot.offline { background: #9e9e9e; }
        @media (max-width: 768px) {
            .chat-sidebar, .users-list { display: none; }
        }
    </style>
</head>
<body>
    <div id="authContainer" class="auth-container">
        <div class="auth-card">
            <h2 id="authTitle">Login</h2>
            <div>
                <div class="input-group">
                    <input type="text" id="loginUsername" placeholder="Username">
                </div>
                <div class="input-group">
                    <input type="password" id="loginPassword" placeholder="Password">
                </div>
                <button class="btn" onclick="handleAuth()" id="authBtn">Login</button>
                <div class="auth-switch">
                    Don't have an account? <a onclick="toggleAuth()">Register</a>
                </div>
            </div>
        </div>
    </div>

    <div id="chatContainer" class="chat-container">
        <div style="display: flex; height: 100vh;">
            <div class="chat-sidebar">
                <div class="user-info">
                    <div class="user-name" id="currentUser">Loading...</div>
                    <button class="logout-btn" onclick="logout()">Logout</button>
                </div>
                <div class="rooms-list" id="roomsList"></div>
            </div>
            <div class="chat-main">
                <div class="chat-header">
                    <div class="current-room" id="currentRoom">General Chat</div>
                </div>
                <div class="messages-area" id="messagesArea"></div>
                <div class="chat-input-area">
                    <input type="text" class="chat-input" id="messageInput" placeholder="Type your message..." onkeypress="if(event.key==='Enter') sendMessage()">
                    <button class="send-btn" onclick="sendMessage()">Send</button>
                </div>
            </div>
            <div class="users-list">
                <h4>Users</h4>
                <div id="usersList"></div>
            </div>
        </div>
    </div>

    <script>
        let currentUser = null;
        let currentRoom = 'general';
        let token = null;
        let messageInterval = null;

        async function handleAuth() {
            const isLogin = document.getElementById('authTitle').innerText === 'Login';
            const username = document.getElementById('loginUsername').value;
            const password = document.getElementById('loginPassword').value;
            
            if (!username || !password) {
                alert('Please enter username and password');
                return;
            }
            
            if (isLogin) {
                await login(username, password);
            } else {
                const email = prompt('Enter your email address:');
                if (email) await register(username, email, password);
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
                    showChat();
                    loadMessages();
                    loadRooms();
                    loadUsers();
                    startPolling();
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
                    showChat();
                    loadMessages();
                    loadRooms();
                    loadUsers();
                    startPolling();
                } else {
                    alert('Registration failed: ' + data.error);
                }
            } catch (err) {
                alert('Error: ' + err.message);
            }
        }

        function toggleAuth() {
            const title = document.getElementById('authTitle');
            const btn = document.getElementById('authBtn');
            const switchText = document.querySelector('.auth-switch');
            
            if (title.innerText === 'Login') {
                title.innerText = 'Register';
                btn.innerText = 'Register';
                switchText.innerHTML = 'Already have an account? <a onclick="toggleAuth()">Login</a>';
            } else {
                title.innerText = 'Login';
                btn.innerText = 'Login';
                switchText.innerHTML = 'Don\\'t have an account? <a onclick="toggleAuth()">Register</a>';
            }
        }

        function showChat() {
            document.getElementById('authContainer').style.display = 'none';
            document.getElementById('chatContainer').style.display = 'block';
            document.getElementById('currentUser').innerText = currentUser.username;
        }

        async function loadMessages() {
            try {
                const res = await fetch('/api/messages?room=' + currentRoom, {
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                const messages = await res.json();
                const messagesArea = document.getElementById('messagesArea');
                messagesArea.innerHTML = '';
                if (messages && messages.length > 0) {
                    messages.forEach(msg => {
                        const messageDiv = document.createElement('div');
                        messageDiv.className = 'message ' + (msg.user_id === currentUser.id ? 'message-own' : '');
                        messageDiv.innerHTML = '<div class="message-bubble">' +
                            '<div class="message-sender">' + escapeHtml(msg.username) + '</div>' +
                            '<div>' + escapeHtml(msg.message) + '</div>' +
                            '<div class="message-time">' + new Date(msg.created_at).toLocaleTimeString() + '</div>' +
                            '</div>';
                        messagesArea.appendChild(messageDiv);
                    });
                    messagesArea.scrollTop = messagesArea.scrollHeight;
                }
            } catch (err) {
                console.error('Load messages error:', err);
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
                    body: JSON.stringify({ roomId: currentRoom, message: message })
                });
                if (res.ok) {
                    input.value = '';
                    loadMessages();
                }
            } catch (err) {
                console.error('Send message error:', err);
            }
        }

        async function loadRooms() {
            try {
                const res = await fetch('/api/rooms', {
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                const rooms = await res.json();
                const roomsList = document.getElementById('roomsList');
                roomsList.innerHTML = '';
                if (rooms && rooms.length > 0) {
                    rooms.forEach(room => {
                        const roomDiv = document.createElement('div');
                        roomDiv.className = 'room-item ' + (room.id === currentRoom ? 'active' : '');
                        roomDiv.innerHTML = '<div class="room-icon">#</div><div>' + escapeHtml(room.name) + '</div>';
                        roomDiv.onclick = () => {
                            currentRoom = room.id;
                            document.getElementById('currentRoom').innerText = room.name;
                            loadMessages();
                            loadRooms();
                        };
                        roomsList.appendChild(roomDiv);
                    });
                }
            } catch (err) {
                console.error('Load rooms error:', err);
            }
        }

        async function loadUsers() {
            try {
                const res = await fetch('/api/users', {
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                const users = await res.json();
                const usersList = document.getElementById('usersList');
                usersList.innerHTML = '';
                if (users && users.length > 0) {
                    users.forEach(user => {
                        const userDiv = document.createElement('div');
                        userDiv.className = 'user-item';
                        userDiv.innerHTML = '<div class="user-status-dot ' + (user.status === 'online' ? '' : 'offline') + '"></div>' +
                            '<div>' + escapeHtml(user.username) + '</div>';
                        usersList.appendChild(userDiv);
                    });
                }
            } catch (err) {
                console.error('Load users error:', err);
            }
        }

        async function logout() {
            localStorage.removeItem('token');
            localStorage.removeItem('user');
            if (messageInterval) clearInterval(messageInterval);
            location.reload();
        }

        function startPolling() {
            if (messageInterval) clearInterval(messageInterval);
            messageInterval = setInterval(() => {
                if (currentUser) loadMessages();
            }, 3000);
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

        // Check for saved session
        const savedToken = localStorage.getItem('token');
        const savedUser = localStorage.getItem('user');
        if (savedToken && savedUser) {
            token = savedToken;
            currentUser = JSON.parse(savedUser);
            showChat();
            loadMessages();
            loadRooms();
            loadUsers();
            startPolling();
        }
    </script>
</body>
</html>`;
  
  return new Response(html, { headers: { 'Content-Type': 'text/html' } });
}
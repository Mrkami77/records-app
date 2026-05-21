// JWT utilities
async function generateToken(user) {
  const encoder = new TextEncoder();
  const data = `${user.id}|${user.username}|${Date.now()}`;
  return btoa(data);
}

async function verifyToken(token, env) {
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

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Initialize database tables
    try {
      await initDatabase(env);
    } catch (err) {
      console.error('DB Init Error:', err);
    }

    // Auth middleware (except for login/register)
    const publicPaths = ['/api/auth/login', '/api/auth/register', '/api/health', '/'];
    const isPublic = publicPaths.some(p => path === p || path.startsWith('/api/public'));
    
    let user = null;
    if (!isPublic) {
      const authHeader = request.headers.get('Authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), 
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const token = authHeader.split(' ')[1];
      user = await verifyToken(token, env);
      if (!user) {
        return new Response(JSON.stringify({ error: 'Invalid token' }), 
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    // Routes
    if (path === '/' || path === '/index.html') {
      return serveHTML();
    }

    // Auth routes
    if (path === '/api/auth/register' && method === 'POST') {
      return handleRegister(request, env);
    }
    if (path === '/api/auth/login' && method === 'POST') {
      return handleLogin(request, env);
    }
    if (path === '/api/auth/logout' && method === 'POST') {
      return new Response(JSON.stringify({ success: true }), 
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Messages routes
    if (path === '/api/messages' && method === 'GET') {
      const roomId = url.searchParams.get('room') || 'general';
      const limit = parseInt(url.searchParams.get('limit')) || 50;
      return getMessages(env, roomId, limit);
    }
    if (path === '/api/messages' && method === 'POST') {
      return sendMessage(request, env, user);
    }
    if (path.match(/\/api\/messages\/\d+/) && method === 'DELETE') {
      const messageId = parseInt(path.split('/').pop());
      return deleteMessage(env, messageId, user);
    }

    // Rooms routes
    if (path === '/api/rooms' && method === 'GET') {
      return getRooms(env, user);
    }
    if (path === '/api/rooms' && method === 'POST') {
      return createRoom(request, env, user);
    }

    // Users routes
    if (path === '/api/users' && method === 'GET') {
      return getUsers(env);
    }
    if (path === '/api/users/status' && method === 'PUT') {
      return updateStatus(request, env, user);
    }

    // Health check
    if (path === '/api/health') {
      return new Response(JSON.stringify({ status: 'healthy', timestamp: new Date().toISOString() }), 
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Not Found' }), 
      { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  },
};

async function initDatabase(env) {
  // Create tables if not exist
  const tables = [
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      avatar TEXT,
      status TEXT DEFAULT 'offline',
      role TEXT DEFAULT 'user',
      last_seen DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      message TEXT NOT NULL,
      message_type TEXT DEFAULT 'text',
      file_url TEXT,
      is_deleted BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT DEFAULT 'public',
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, created_at)`
  ];
  
  for (const sql of tables) {
    await env.DB.prepare(sql).run();
  }
  
  // Insert default rooms
  const defaultRooms = [
    ['general', 'General Chat', 'public'],
    ['random', 'Random Talks', 'public'],
    ['tech', 'Technology', 'public']
  ];
  
  for (const [id, name, type] of defaultRooms) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO rooms (id, name, type) VALUES (?, ?, ?)`
    ).bind(id, name, type).run();
  }
}

async function handleRegister(request, env) {
  try {
    const { username, email, password } = await request.json();
    
    if (!username || !email || !password) {
      return new Response(JSON.stringify({ error: 'All fields required' }), 
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    
    // Simple password hash (use bcrypt in production)
    const hash = btoa(password + 'salt');
    
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
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
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
    const hash = btoa(password + 'salt');
    
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
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), 
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

async function getMessages(env, roomId, limit) {
  const messages = await env.DB.prepare(
    `SELECT id, user_id, username, message, message_type, file_url, created_at 
     FROM messages 
     WHERE room_id = ? AND is_deleted = 0 
     ORDER BY created_at DESC LIMIT ?`
  ).bind(roomId, limit).all();
  
  return new Response(JSON.stringify(messages.results.reverse()), 
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

async function sendMessage(request, env, user) {
  try {
    const { roomId, message, messageType = 'text', fileUrl } = await request.json();
    
    await env.DB.prepare(
      `INSERT INTO messages (room_id, user_id, username, message, message_type, file_url) 
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(roomId, user.id, user.username, message, messageType, fileUrl).run();
    
    const newMessage = await env.DB.prepare(
      `SELECT id, user_id, username, message, message_type, file_url, created_at 
       FROM messages WHERE id = last_insert_rowid()`
    ).first();
    
    return new Response(JSON.stringify({ success: true, message: newMessage }), 
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), 
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

async function deleteMessage(env, messageId, user) {
  const message = await env.DB.prepare(
    `SELECT user_id FROM messages WHERE id = ?`
  ).bind(messageId).first();
  
  if (!message || (message.user_id !== user.id && user.role !== 'admin')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), 
      { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
  
  await env.DB.prepare(
    `UPDATE messages SET is_deleted = 1 WHERE id = ?`
  ).bind(messageId).run();
  
  return new Response(JSON.stringify({ success: true }), 
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

async function getRooms(env, user) {
  const rooms = await env.DB.prepare(
    `SELECT id, name, type, created_at FROM rooms ORDER BY name`
  ).all();
  
  return new Response(JSON.stringify(rooms.results), 
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

async function createRoom(request, env, user) {
  try {
    const { id, name, type = 'public' } = await request.json();
    
    await env.DB.prepare(
      `INSERT INTO rooms (id, name, type, created_by) VALUES (?, ?, ?, ?)`
    ).bind(id, name, type, user.id).run();
    
    return new Response(JSON.stringify({ success: true, room: { id, name, type } }), 
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), 
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

async function getUsers(env) {
  const users = await env.DB.prepare(
    `SELECT id, username, avatar, status, last_seen FROM users ORDER BY username`
  ).all();
  
  return new Response(JSON.stringify(users.results), 
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

async function updateStatus(request, env, user) {
  try {
    const { status } = await request.json();
    
    await env.DB.prepare(
      `UPDATE users SET status = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?`
    ).bind(status, user.id).run();
    
    return new Response(JSON.stringify({ success: true }), 
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), 
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

function serveHTML() {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Enterprise Chat - Professional Communication Platform</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            height: 100vh;
            overflow: hidden;
        }

        /* Auth Container */
        .auth-container {
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            backdrop-filter: blur(10px);
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
            from {
                opacity: 0;
                transform: translateY(50px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
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
            transition: all 0.3s;
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
            transition: transform 0.2s;
        }

        .btn:hover {
            transform: translateY(-2px);
        }

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

        /* Chat Container */
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
            border-bottom: 1px solid #e0e0e0;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }

        .user-name {
            font-size: 18px;
            font-weight: 600;
        }

        .user-status {
            font-size: 12px;
            opacity: 0.9;
            margin-top: 5px;
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
            transition: all 0.3s;
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .room-item:hover {
            background: #f0f0f0;
        }

        .room-item.active {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }

        .room-icon {
            width: 30px;
            height: 30px;
            background: #e0e0e0;
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
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
            box-shadow: 0 2px 4px rgba(0,0,0,0.05);
        }

        .current-room {
            font-size: 20px;
            font-weight: 600;
            color: #333;
        }

        .messages-area {
            flex: 1;
            overflow-y: auto;
            padding: 20px;
            display: flex;
            flex-direction: column;
            gap: 15px;
        }

        .message {
            display: flex;
            animation: fadeIn 0.3s ease;
        }

        @keyframes fadeIn {
            from {
                opacity: 0;
                transform: translateY(10px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        .message-own {
            justify-content: flex-end;
        }

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

        .message-sender {
            font-size: 12px;
            font-weight: 600;
            margin-bottom: 5px;
            color: #667eea;
        }

        .message-own .message-sender {
            color: rgba(255,255,255,0.9);
        }

        .message-time {
            font-size: 10px;
            margin-top: 5px;
            opacity: 0.7;
            text-align: right;
        }

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
            font-size: 14px;
        }

        .chat-input:focus {
            outline: none;
            border-color: #667eea;
        }

        .send-btn {
            padding: 12px 30px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            border-radius: 10px;
            cursor: pointer;
            font-weight: 600;
        }

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

        .users-list {
            width: 250px;
            background: white;
            border-left: 1px solid #e0e0e0;
            padding: 20px;
            overflow-y: auto;
        }

        .users-list h4 {
            margin-bottom: 15px;
            color: #333;
        }

        .user-item {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 8px;
            margin: 5px 0;
            border-radius: 8px;
            cursor: pointer;
        }

        .user-status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #4caf50;
        }

        .user-status-dot.offline {
            background: #9e9e9e;
        }

        @media (max-width: 768px) {
            .chat-sidebar, .users-list {
                display: none;
            }
        }
    </style>
  </head>
  <body>
    <!-- Auth Container -->
    <div id="authContainer" class="auth-container">
        <div class="auth-card">
            <h2 id="authTitle">Login</h2>
            <div id="authForm">
                <div class="input-group">
                    <input type="text" id="loginUsername" placeholder="Username">
                </div>
                <div class="input-group">
                    <input type="password" id="loginPassword" placeholder="Password">
                </div>
                <button class="btn" onclick="handleAuth()">Login</button>
                <div class="auth-switch">
                    Don't have an account? <a onclick="toggleAuth()">Register</a>
                </div>
            </div>
        </div>
    </div>

    <!-- Chat Container -->
    <div id="chatContainer" class="chat-container" style="display: none;">
        <div style="display: flex; height: 100vh;">
            <!-- Sidebar -->
            <div class="chat-sidebar">
                <div class="user-info">
                    <div class="user-name" id="currentUser">Loading...</div>
                    <div class="user-status">Online</div>
                    <button class="logout-btn" onclick="logout()">Logout</button>
                </div>
                <div class="rooms-list" id="roomsList"></div>
            </div>

            <!-- Chat Main -->
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

            <!-- Users List -->
            <div class="users-list">
                <h4>Online Users</h4>
                <div id="usersList"></div>
            </div>
        </div>
    </div>

    <script>
        let currentUser = null;
        let currentRoom = 'general';
        let token = null;
        let messagePolling = null;

        async function handleAuth() {
            const isLogin = document.getElementById('authTitle').innerText === 'Login';
            if (isLogin) {
                const username = document.getElementById('loginUsername').value;
                const password = document.getElementById('loginPassword').value;
                await login(username, password);
            } else {
                const username = document.getElementById('loginUsername').value;
                const password = document.getElementById('loginPassword').value;
                const email = prompt('Enter your email:');
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
            const btn = document.querySelector('#authForm .btn');
            const switchText = document.querySelector('.auth-switch');
            
            if (title.innerText === 'Login') {
                title.innerText = 'Register';
                btn.innerText = 'Register';
                switchText.innerHTML = 'Already have an account? <a onclick="toggleAuth()">Login</a>';
            } else {
                title.innerText = 'Login';
                btn.innerText = 'Login';
                switchText.innerHTML = 'Don\'t have an account? <a onclick="toggleAuth()">Register</a>';
            }
        }

        function showChat() {
            document.getElementById('authContainer').style.display = 'none';
            document.getElementById('chatContainer').style.display = 'block';
            document.getElementById('currentUser').innerText = currentUser.username;
        }

        async function loadMessages() {
            try {
                const res = await fetch(`/api/messages?room=${currentRoom}`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                const messages = await res.json();
                const messagesArea = document.getElementById('messagesArea');
                messagesArea.innerHTML = '';
                messages.forEach(msg => {
                    const messageDiv = document.createElement('div');
                    messageDiv.className = `message ${msg.user_id === currentUser.id ? 'message-own' : ''}`;
                    messageDiv.innerHTML = \`
                        <div class="message-bubble">
                            <div class="message-sender">\${escapeHtml(msg.username)}</div>
                            <div>\${escapeHtml(msg.message)}</div>
                            <div class="message-time">\${new Date(msg.created_at).toLocaleTimeString()}</div>
                        </div>
                    \`;
                    messagesArea.appendChild(messageDiv);
                });
                messagesArea.scrollTop = messagesArea.scrollHeight;
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
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({ roomId: currentRoom, message })
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
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                const rooms = await res.json();
                const roomsList = document.getElementById('roomsList');
                roomsList.innerHTML = '';
                rooms.forEach(room => {
                    const roomDiv = document.createElement('div');
                    roomDiv.className = \`room-item \${room.id === currentRoom ? 'active' : ''}\`;
                    roomDiv.innerHTML = \`
                        <div class="room-icon">#</div>
                        <div>\${escapeHtml(room.name)}</div>
                    \`;
                    roomDiv.onclick = () => {
                        currentRoom = room.id;
                        document.getElementById('currentRoom').innerText = room.name;
                        loadMessages();
                        loadRooms();
                    };
                    roomsList.appendChild(roomDiv);
                });
            } catch (err) {
                console.error('Load rooms error:', err);
            }
        }

        async function loadUsers() {
            try {
                const res = await fetch('/api/users', {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                const users = await res.json();
                const usersList = document.getElementById('usersList');
                usersList.innerHTML = '';
                users.forEach(user => {
                    const userDiv = document.createElement('div');
                    userDiv.className = 'user-item';
                    userDiv.innerHTML = \`
                        <div class="user-status-dot \${user.status === 'online' ? '' : 'offline'}"></div>
                        <div>\${escapeHtml(user.username)}</div>
                    \`;
                    usersList.appendChild(userDiv);
                });
            } catch (err) {
                console.error('Load users error:', err);
            }
        }

        async function logout() {
            localStorage.removeItem('token');
            localStorage.removeItem('user');
            if (messagePolling) clearInterval(messagePolling);
            location.reload();
        }

        function startPolling() {
            if (messagePolling) clearInterval(messagePolling);
            messagePolling = setInterval(() => {
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

        // Check for existing session
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
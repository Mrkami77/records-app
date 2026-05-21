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

    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      await initDatabase(env);
    } catch (err) {
      console.error('DB Init Error:', err);
    }

    const publicPaths = ['/api/auth/login', '/api/auth/register', '/api/health', '/'];
    const isPublic = publicPaths.some(p => path === p);
    
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
      return getRooms(env, user);
    }
    if (path === '/api/users' && method === 'GET') {
      return getUsers(env);
    }
    if (path === '/api/users/status' && method === 'PUT') {
      return updateStatus(request, env, user);
    }
    if (path === '/api/health') {
      return new Response(JSON.stringify({ status: 'healthy', timestamp: new Date().toISOString() }), 
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Not Found' }), 
      { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  },
};

async function initDatabase(env) {
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
    
    const result = await env.DB.prepare(
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

async function getRooms(env, user) {
  const rooms = await env.DB.prepare(
    `SELECT id, name, type, created_at FROM rooms ORDER BY name`
  ).all();
  
  return new Response(JSON.stringify(rooms.results), 
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
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
  const html = '<!DOCTYPE html>\n<html lang="en">\n<head>\n    <meta charset="UTF-8">\n    <meta name="viewport" content="width=device-width, initial-scale=1.0">\n    <title>Enterprise Chat - Professional Communication Platform</title>\n    <style>\n        * {\n            margin: 0;\n            padding: 0;\n            box-sizing: border-box;\n        }\n\n        body {\n            font-family: -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, \'Helvetica Neue\', sans-serif;\n            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);\n            height: 100vh;\n            overflow: hidden;\n        }\n\n        .auth-container {\n            display: flex;\n            justify-content: center;\n            align-items: center;\n            height: 100vh;\n            backdrop-filter: blur(10px);\n        }\n\n        .auth-card {\n            background: white;\n            border-radius: 20px;\n            padding: 40px;\n            width: 400px;\n            box-shadow: 0 20px 60px rgba(0,0,0,0.3);\n            animation: slideUp 0.5s ease;\n        }\n\n        @keyframes slideUp {\n            from {\n                opacity: 0;\n                transform: translateY(50px);\n            }\n            to {\n                opacity: 1;\n                transform: translateY(0);\n            }\n        }\n\n        .auth-card h2 {\n            margin-bottom: 30px;\n            color: #333;\n            text-align: center;\n        }\n\n        .input-group {\n            margin-bottom: 20px;\n        }\n\n        .input-group input {\n            width: 100%;\n            padding: 12px 15px;\n            border: 2px solid #e0e0e0;\n            border-radius: 10px;\n            font-size: 14px;\n            transition: all 0.3s;\n        }\n\n        .input-group input:focus {\n            outline: none;\n            border-color: #667eea;\n        }\n\n        .btn {\n            width: 100%;\n            padding: 12px;\n            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);\n            color: white;\n            border: none;\n            border-radius: 10px;\n            font-size: 16px;\n            font-weight: 600;\n            cursor: pointer;\n            transition: transform 0.2s;\n        }\n\n        .btn:hover {\n            transform: translateY(-2px);\n        }\n\n        .auth-switch {\n            text-align: center;\n            margin-top: 20px;\n            color: #666;\n        }\n\n        .auth-switch a {\n            color: #667eea;\n            text-decoration: none;\n            cursor: pointer;\n        }\n\n        .chat-container {\n            display: none;\n            height: 100vh;\n            background: #f5f7fb;\n        }\n\n        .chat-sidebar {\n            background: white;\n            width: 280px;\n            border-right: 1px solid #e0e0e0;\n            display: flex;\n            flex-direction: column;\n        }\n\n        .user-info {\n            padding: 20px;\n            border-bottom: 1px solid #e0e0e0;\n            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);\n            color: white;\n        }\n\n        .user-name {\n            font-size: 18px;\n            font-weight: 600;\n        }\n\n        .user-status {\n            font-size: 12px;\n            opacity: 0.9;\n            margin-top: 5px;\n        }\n\n        .rooms-list {\n            flex: 1;\n            overflow-y: auto;\n            padding: 10px;\n        }\n\n        .room-item {\n            padding: 12px 15px;\n            margin: 5px 0;\n            border-radius: 10px;\n            cursor: pointer;\n            transition: all 0.3s;\n            display: flex;\n            align-items: center;\n            gap: 10px;\n        }\n\n        .room-item:hover {\n            background: #f0f0f0;\n        }\n\n        .room-item.active {\n            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);\n            color: white;\n        }\n\n        .room-icon {\n            width: 30px;\n            height: 30px;\n            background: #e0e0e0;\n            border-radius: 8px;\n            display: flex;\n            align-items: center;\n            justify-content: center;\n        }\n\n        .chat-main {\n            flex: 1;\n            display: flex;\n            flex-direction: column;\n        }\n\n        .chat-header {\n            background: white;\n            padding: 20px;\n            border-bottom: 1px solid #e0e0e0;\n            box-shadow: 0 2px 4px rgba(0,0,0,0.05);\n        }\n\n        .current-room {\n            font-size: 20px;\n            font-weight: 600;\n            color: #333;\n        }\n\n        .messages-area {\n            flex: 1;\n            overflow-y: auto;\n            padding: 20px;\n            display: flex;\n            flex-direction: column;\n            gap: 15px;\n        }\n\n        .message {\n            display: flex;\n            animation: fadeIn 0.3s ease;\n        }\n\n        @keyframes fadeIn {\n            from {\n                opacity: 0;\n                transform: translateY(10px);\n            }\n            to {\n                opacity: 1;\n                transform: translateY(0);\n            }\n        }\n\n        .message-own {\n            justify-content: flex-end;\n        }\n\n        .message-bubble {\n            max-width: 60%;\n            padding: 10px 15px;\n            border-radius: 15px;\n            background: white;\n            box-shadow: 0 1px 2px rgba(0,0,0,0.1);\n        }\n\n        .message-own .message-bubble {\n            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);\n            color: white;\n        }\n\n        .message-sender {\n            font-size: 12px;\n            font-weight: 600;\n            margin-bottom: 5px;\n            color: #667eea;\n        }\n\n        .message-own .message-sender {\n            color: rgba(255,255,255,0.9);\n        }\n\n        .message-time {\n            font-size: 10px;\n            margin-top: 5px;\n            opacity: 0.7;\n            text-align: right;\n        }\n\n        .chat-input-area {\n            background: white;\n            padding: 20px;\n            border-top: 1px solid #e0e0e0;\n            display: flex;\n            gap: 10px;\n        }\n\n        .chat-input {\n            flex: 1;\n            padding: 12px;\n            border: 2px solid #e0e0e0;\n            border-radius: 10px;\n            font-size: 14px;\n        }\n\n        .chat-input:focus {\n            outline: none;\n            border-color: #667eea;\n        }\n\n        .send-btn {\n            padding: 12px 30px;\n            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);\n            color: white;\n            border: none;\n            border-radius: 10px;\n            cursor: pointer;\n            font-weight: 600;\n        }\n\n        .logout-btn {\n            margin-top: 10px;\n            background: rgba(255,255,255,0.2);\n            border: 1px solid rgba(255,255,255,0.3);\n            color: white;\n            padding: 8px;\n            border-radius: 8px;\n            cursor: pointer;\n            width: 100%;\n        }\n\n        .users-list {\n            width: 250px;\n            background: white;\n            border-left: 1px solid #e0e0e0;\n            padding: 20px;\n            overflow-y: auto;\n        }\n\n        .users-list h4 {\n            margin-bottom: 15px;\n            color: #333;\n        }\n\n        .user-item {\n            display: flex;\n            align-items: center;\n            gap: 10px;\n            padding: 8px;\n            margin: 5px 0;\n            border-radius: 8px;\n            cursor: pointer;\n        }\n\n        .user-status-dot {\n            width: 8px;\n            height: 8px;\n            border-radius: 50%;\n            background: #4caf50;\n        }\n\n        .user-status-dot.offline {\n            background: #9e9e9e;\n        }\n\n        @media (max-width: 768px) {\n            .chat-sidebar, .users-list {\n                display: none;\n            }\n        }\n    </style>\n</head>\n<body>\n    <div id="authContainer" class="auth-container">\n        <div class="auth-card">\n            <h2 id="authTitle">Login</h2>\n            <div id="authForm">\n                <div class="input-group">\n                    <input type="text" id="loginUsername" placeholder="Username">\n                </div>\n                <div class="input-group">\n                    <input type="password" id="loginPassword" placeholder="Password">\n                </div>\n                <button class="btn" onclick="handleAuth()">Login</button>\n                <div class="auth-switch">\n                    Don\'t have an account? <a onclick="toggleAuth()">Register</a>\n                </div>\n            </div>\n        </div>\n    </div>\n\n    <div id="chatContainer" class="chat-container" style="display: none;">\n        <div style="display: flex; height: 100vh;">\n            <div class="chat-sidebar">\n                <div class="user-info">\n                    <div class="user-name" id="currentUser">Loading...</div>\n                    <div class="user-status">Online</div>\n                    <button class="logout-btn" onclick="logout()">Logout</button>\n                </div>\n                <div class="rooms-list" id="roomsList"></div>\n            </div>\n\n            <div class="chat-main">\n                <div class="chat-header">\n                    <div class="current-room" id="currentRoom">General Chat</div>\n                </div>\n                <div class="messages-area" id="messagesArea"></div>\n                <div class="chat-input-area">\n                    <input type="text" class="chat-input" id="messageInput" placeholder="Type your message..." onkeypress="if(event.key===\'Enter\') sendMessage()">\n                    <button class="send-btn" onclick="sendMessage()">Send</button>\n                </div>\n            </div>\n\n            <div class="users-list">\n                <h4>Online Users</h4>\n                <div id="usersList"></div>\n            </div>\n        </div>\n    </div>\n\n    <script>\n        let currentUser = null;\n        let currentRoom = \'general\';\n        let token = null;\n        let messagePolling = null;\n\n        async function handleAuth() {\n            const isLogin = document.getElementById(\'authTitle\').innerText === \'Login\';\n            if (isLogin) {\n                const username = document.getElementById(\'loginUsername\').value;\n                const password = document.getElementById(\'loginPassword\').value;\n                await login(username, password);\n            } else {\n                const username = document.getElementById(\'loginUsername\').value;\n                const password = document.getElementById(\'loginPassword\').value;\n                const email = prompt(\'Enter your email:\');\n                if (email) await register(username, email, password);\n            }\n        }\n\n        async function login(username, password) {\n            try {\n                const res = await fetch(\'/api/auth/login\', {\n                    method: \'POST\',\n                    headers: { \'Content-Type\': \'application/json\' },\n                    body: JSON.stringify({ username, password })\n                });\n                const data = await res.json();\n                if (data.success) {\n                    token = data.token;\n                    currentUser = data.user;\n                    localStorage.setItem(\'token\', token);\n                    localStorage.setItem(\'user\', JSON.stringify(currentUser));\n                    showChat();\n                    loadMessages();\n                    loadRooms();\n                    loadUsers();\n                    startPolling();\n                } else {\n                    alert(\'Login failed: \' + data.error);\n                }\n            } catch (err) {\n                alert(\'Error: \' + err.message);\n            }\n        }\n\n        async function register(username, email, password) {\n            try {\n                const res = await fetch(\'/api/auth/register\', {\n                    method: \'POST\',\n                    headers: { \'Content-Type\': \'application/json\' },\n                    body: JSON.stringify({ username, email, password })\n                });\n                const data = await res.json();\n                if (data.success) {\n                    token = data.token;\n                    currentUser = data.user;\n                    localStorage.setItem(\'token\', token);\n                    localStorage.setItem(\'user\', JSON.stringify(currentUser));\n                    showChat();\n                    loadMessages();\n                    loadRooms();\n                    loadUsers();\n                    startPolling();\n                } else {\n                    alert(\'Registration failed: \' + data.error);\n                }\n            } catch (err) {\n                alert(\'Error: \' + err.message);\n            }\n        }\n\n        function toggleAuth() {\n            const title = document.getElementById(\'authTitle\');\n            const btn = document.querySelector(\'#authForm .btn\');\n            const switchText = document.querySelector(\'.auth-switch\');\n            \n            if (title.innerText === \'Login\') {\n                title.innerText = \'Register\';\n                btn.innerText = \'Register\';\n                switchText.innerHTML = \'Already have an account? <a onclick="toggleAuth()">Login</a>\';\n            } else {\n                title.innerText = \'Login\';\n                btn.innerText = \'Login\';\n                switchText.innerHTML = \'Don\\\'t have an account? <a onclick="toggleAuth()">Register</a>\';\n            }\n        }\n\n        function showChat() {\n            document.getElementById(\'authContainer\').style.display = \'none\';\n            document.getElementById(\'chatContainer\').style.display = \'block\';\n            document.getElementById(\'currentUser\').innerText = currentUser.username;\n        }\n\n        async function loadMessages() {\n            try {\n                const res = await fetch(`/api/messages?room=${currentRoom}`, {\n                    headers: { \'Authorization\': `Bearer ${token}` }\n                });\n                const messages = await res.json();\n                const messagesArea = document.getElementById(\'messagesArea\');\n                messagesArea.innerHTML = \'\';\n                messages.forEach(msg => {\n                    const messageDiv = document.createElement(\'div\');\n                    messageDiv.className = `message ${msg.user_id === currentUser.id ? \'message-own\' : \'\'}`;\n                    messageDiv.innerHTML = `\n                        <div class="message-bubble">\n                            <div class="message-sender">${escapeHtml(msg.username)}</div>\n                            <div>${escapeHtml(msg.message)}</div>\n                            <div class="message-time">${new Date(msg.created_at).toLocaleTimeString()}</div>\n                        </div>\n                    `;\n                    messagesArea.appendChild(messageDiv);\n                });\n                messagesArea.scrollTop = messagesArea.scrollHeight;\n            } catch (err) {\n                console.error(\'Load messages error:\', err);\n            }\n        }\n\n        async function sendMessage() {\n            const input = document.getElementById(\'messageInput\');\n            const message = input.value.trim();\n            if (!message) return;\n            \n            try {\n                const res = await fetch(\'/api/messages\', {\n                    method: \'POST\',\n                    headers: {\n                        \'Content-Type\': \'application/json\',\n                        \'Authorization\': `Bearer ${token}`\n                    },\n                    body: JSON.stringify({ roomId: currentRoom, message })\n                });\n                if (res.ok) {\n                    input.value = \'\';\n                    loadMessages();\n                }\n            } catch (err) {\n                console.error(\'Send message error:\', err);\n            }\n        }\n\n        async function loadRooms() {\n            try {\n                const res = await fetch(\'/api/rooms\', {\n                    headers: { \'Authorization\': `Bearer ${token}` }\n                });\n                const rooms = await res.json();\n                const roomsList = document.getElementById(\'roomsList\');\n                roomsList.innerHTML = \'\';\n                rooms.forEach(room => {\n                    const roomDiv = document.createElement(\'div\');\n                    roomDiv.className = `room-item ${room.id === currentRoom ? \'active\' : \'\'}`;\n                    roomDiv.innerHTML = `\n                        <div class="room-icon">#</div>\n                        <div>${escapeHtml(room.name)}</div>\n                    `;\n                    roomDiv.onclick = () => {\n                        currentRoom = room.id;\n                        document.getElementById(\'currentRoom\').innerText = room.name;\n                        loadMessages();\n                        loadRooms();\n                    };\n                    roomsList.appendChild(roomDiv);\n                });\n            } catch (err) {\n                console.error(\'Load rooms error:\', err);\n            }\n        }\n\n        async function loadUsers() {\n            try {\n                const res = await fetch(\'/api/users\', {\n                    headers: { \'Authorization\': `Bearer ${token}` }\n                });\n                const users = await res.json();\n                const usersList = document.getElementById(\'usersList\');\n                usersList.innerHTML = \'\';\n                users.forEach(user => {\n                    const userDiv = document.createElement(\'div\');\n                    userDiv.className = \'user-item\';\n                    userDiv.innerHTML = `\n                        <div class="user-status-dot ${user.status === \'online\' ? \'\' : \'offline\'}"></div>\n                        <div>${escapeHtml(user.username)}</div>\n                    `;\n                    usersList.appendChild(userDiv);\n                });\n            } catch (err) {\n                console.error(\'Load users error:\', err);\n            }\n        }\n\n        async function logout() {\n            localStorage.removeItem(\'token\');\n            localStorage.removeItem(\'user\');\n            if (messagePolling) clearInterval(messagePolling);\n            location.reload();\n        }\n\n        function startPolling() {\n            if (messagePolling) clearInterval(messagePolling);\n            messagePolling = setInterval(() => {\n                if (currentUser) loadMessages();\n            }, 3000);\n        }\n\n        function escapeHtml(str) {\n            if (!str) return \'\';\n            return str.replace(/[&<>]/g, function(m) {\n                if (m === \'&\') return \'&amp;\';\n                if (m === \'<\') return \'&lt;\';\n                if (m === \'>\') return \'&gt;\';\n                return m;\n            });\n        }\n\n        const savedToken = localStorage.getItem(\'token\');\n        const savedUser = localStorage.getItem(\'user\');\n        if (savedToken && savedUser) {\n            token = savedToken;\n            currentUser = JSON.parse(savedUser);\n            showChat();\n            loadMessages();\n            loadRooms();\n            loadUsers();\n            startPolling();\n        }\n    </script>\n</body>\n</html>';
  
  return new Response(html, { headers: { 'Content-Type': 'text/html' } });
}
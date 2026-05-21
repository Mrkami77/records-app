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
      const limit = parseInt(url.searchParams.get('limit')) || 100;
      const before = url.searchParams.get('before');
      return getMessages(env, roomId, limit, before);
    }
    
    if (path === '/api/messages' && method === 'POST') {
      return sendMessage(request, env, user);
    }
    
    if (path.match(/\/api\/messages\/\d+\/react/) && method === 'POST') {
      return addReaction(request, env, user);
    }
    
    if (path === '/api/rooms' && method === 'GET') {
      return getRooms(env);
    }
    
    if (path === '/api/rooms' && method === 'POST') {
      return createRoom(request, env, user);
    }
    
    if (path === '/api/users' && method === 'GET') {
      return getUsers(env);
    }
    
    if (path === '/api/users/typing' && method === 'POST') {
      return typingIndicator(request, env, user);
    }
    
    if (path === '/api/search' && method === 'GET') {
      const q = url.searchParams.get('q');
      return searchMessages(env, q);
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

async function getMessages(env, roomId, limit, before) {
  try {
    let query = `SELECT id, user_id, username, message, message_type, file_url, created_at, reactions 
                 FROM messages 
                 WHERE room_id = ? AND (is_deleted = 0 OR is_deleted IS NULL)`;
    let params = [roomId];
    
    if (before) {
      query += ` AND id < ?`;
      params.push(parseInt(before));
    }
    
    query += ` ORDER BY created_at DESC LIMIT ?`;
    params.push(limit);
    
    const messages = await env.DB.prepare(query).bind(...params).all();
    
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
    const { roomId, message, messageType = 'text', replyToId = null } = await request.json();
    
    if (!message || message.trim() === '') {
      return new Response(JSON.stringify({ error: 'Message cannot be empty' }), 
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    
    const result = await env.DB.prepare(
      `INSERT INTO messages (room_id, user_id, username, message, message_type, reply_to) 
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(roomId, user.id, user.username, message, messageType, replyToId).run();
    
    const newMessage = await env.DB.prepare(
      `SELECT id, user_id, username, message, message_type, created_at, reactions 
       FROM messages WHERE id = last_insert_rowid()`
    ).first();
    
    return new Response(JSON.stringify({ success: true, message: newMessage }), 
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), 
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

async function addReaction(request, env, user) {
  try {
    const url = new URL(request.url);
    const messageId = parseInt(url.pathname.split('/')[3]);
    const { reaction } = await request.json();
    
    const message = await env.DB.prepare(`SELECT reactions FROM messages WHERE id = ?`).bind(messageId).first();
    let reactions = message.reactions ? JSON.parse(message.reactions) : {};
    
    if (!reactions[reaction]) {
      reactions[reaction] = [];
    }
    
    if (!reactions[reaction].includes(user.id)) {
      reactions[reaction].push(user.id);
    }
    
    await env.DB.prepare(`UPDATE messages SET reactions = ? WHERE id = ?`)
      .bind(JSON.stringify(reactions), messageId).run();
    
    return new Response(JSON.stringify({ success: true }), 
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), 
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

async function getRooms(env) {
  try {
    const rooms = await env.DB.prepare(
      `SELECT id, name, type, icon, created_at FROM rooms ORDER BY name`
    ).all();
    
    return new Response(JSON.stringify(rooms.results || []), 
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify([]), 
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

async function createRoom(request, env, user) {
  try {
    const { id, name, type = 'public', icon = '#' } = await request.json();
    
    await env.DB.prepare(
      `INSERT INTO rooms (id, name, type, icon, created_by) VALUES (?, ?, ?, ?, ?)`
    ).bind(id, name, type, icon, user.id).run();
    
    return new Response(JSON.stringify({ success: true, room: { id, name, type, icon } }), 
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), 
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

async function getUsers(env) {
  try {
    const users = await env.DB.prepare(
      `SELECT id, username, avatar, status, last_seen FROM users ORDER BY username`
    ).all();
    
    return new Response(JSON.stringify(users.results || []), 
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify([]), 
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}

async function typingIndicator(request, env, user) {
  // Store typing status in a simple cache (you can use KV for production)
  return new Response(JSON.stringify({ success: true }), 
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

async function searchMessages(env, query) {
  try {
    const messages = await env.DB.prepare(
      `SELECT id, user_id, username, message, room_id, created_at 
       FROM messages 
       WHERE message LIKE ? 
       ORDER BY created_at DESC LIMIT 50`
    ).bind(`%${query}%`).all();
    
    return new Response(JSON.stringify(messages.results || []), 
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
    <title>Enterprise Pro Chat - Team Communication Platform</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        :root {
            --primary: #6366f1;
            --primary-dark: #4f46e5;
            --secondary: #10b981;
            --dark: #1e293b;
            --darker: #0f172a;
            --gray: #64748b;
            --light-gray: #f1f5f9;
            --border: #e2e8f0;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', sans-serif;
            background: var(--darker);
            height: 100vh;
            overflow: hidden;
        }

        /* Auth Styles */
        .auth-container {
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        }

        .auth-card {
            background: white;
            border-radius: 24px;
            padding: 48px;
            width: 440px;
            box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25);
            animation: slideUp 0.5s ease;
        }

        @keyframes slideUp {
            from { opacity: 0; transform: translateY(30px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .auth-card h2 {
            margin-bottom: 32px;
            font-size: 28px;
            background: linear-gradient(135deg, #667eea, #764ba2);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            text-align: center;
        }

        .input-group {
            margin-bottom: 20px;
        }

        .input-group input {
            width: 100%;
            padding: 14px 16px;
            border: 2px solid var(--border);
            border-radius: 12px;
            font-size: 14px;
            transition: all 0.3s;
        }

        .input-group input:focus {
            outline: none;
            border-color: var(--primary);
            box-shadow: 0 0 0 3px rgba(99,102,241,0.1);
        }

        .btn {
            width: 100%;
            padding: 14px;
            background: linear-gradient(135deg, var(--primary), var(--primary-dark));
            color: white;
            border: none;
            border-radius: 12px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: transform 0.2s, box-shadow 0.2s;
        }

        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 20px -5px rgba(99,102,241,0.4);
        }

        .auth-switch {
            text-align: center;
            margin-top: 24px;
            color: var(--gray);
        }

        .auth-switch a {
            color: var(--primary);
            text-decoration: none;
            cursor: pointer;
            font-weight: 600;
        }

        /* Chat Container */
        .chat-container {
            display: none;
            height: 100vh;
            background: var(--light-gray);
        }

        .app-layout {
            display: flex;
            height: 100vh;
        }

        /* Sidebar */
        .sidebar {
            width: 280px;
            background: white;
            border-right: 1px solid var(--border);
            display: flex;
            flex-direction: column;
        }

        .sidebar-header {
            padding: 24px;
            background: linear-gradient(135deg, var(--primary), var(--primary-dark));
            color: white;
        }

        .workspace-name {
            font-size: 20px;
            font-weight: 700;
            margin-bottom: 8px;
        }

        .user-status-small {
            font-size: 12px;
            opacity: 0.9;
        }

        .nav-menu {
            flex: 1;
            padding: 16px;
        }

        .nav-section {
            margin-bottom: 24px;
        }

        .nav-section-title {
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--gray);
            margin-bottom: 12px;
            padding: 0 12px;
        }

        .room-item {
            padding: 10px 12px;
            margin: 4px 0;
            border-radius: 10px;
            cursor: pointer;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            gap: 12px;
            color: var(--dark);
        }

        .room-item i {
            width: 20px;
            color: var(--gray);
        }

        .room-item:hover {
            background: var(--light-gray);
        }

        .room-item.active {
            background: linear-gradient(135deg, var(--primary), var(--primary-dark));
            color: white;
        }

        .room-item.active i {
            color: white;
        }

        .logout-btn {
            margin: 16px;
            padding: 12px;
            background: var(--light-gray);
            border: none;
            border-radius: 10px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 10px;
            color: var(--dark);
            font-weight: 500;
            transition: all 0.2s;
        }

        .logout-btn:hover {
            background: #fee2e2;
            color: #dc2626;
        }

        /* Chat Main */
        .chat-main {
            flex: 1;
            display: flex;
            flex-direction: column;
            background: white;
        }

        .chat-header {
            padding: 20px 24px;
            border-bottom: 1px solid var(--border);
            background: white;
        }

        .current-room-info {
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .current-room-name {
            font-size: 20px;
            font-weight: 700;
            color: var(--dark);
        }

        .room-meta {
            font-size: 13px;
            color: var(--gray);
            margin-top: 4px;
        }

        .search-box {
            display: flex;
            gap: 12px;
            background: var(--light-gray);
            padding: 8px 16px;
            border-radius: 12px;
            align-items: center;
        }

        .search-box input {
            border: none;
            background: none;
            outline: none;
            font-size: 14px;
            width: 200px;
        }

        /* Messages Area */
        .messages-area {
            flex: 1;
            overflow-y: auto;
            padding: 24px;
            display: flex;
            flex-direction: column;
            gap: 16px;
            background: #fafbfc;
        }

        .message-group {
            display: flex;
            gap: 12px;
            animation: fadeIn 0.3s ease;
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .message-avatar {
            width: 36px;
            height: 36px;
            border-radius: 10px;
            background: linear-gradient(135deg, var(--primary), var(--primary-dark));
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-weight: 600;
            flex-shrink: 0;
        }

        .message-content {
            flex: 1;
        }

        .message-header {
            display: flex;
            align-items: baseline;
            gap: 12px;
            margin-bottom: 6px;
        }

        .message-sender {
            font-weight: 700;
            color: var(--dark);
            font-size: 14px;
        }

        .message-time {
            font-size: 11px;
            color: var(--gray);
        }

        .message-text {
            color: var(--dark);
            line-height: 1.5;
            font-size: 14px;
            background: white;
            padding: 8px 12px;
            border-radius: 12px;
            display: inline-block;
            max-width: 70%;
            box-shadow: 0 1px 2px rgba(0,0,0,0.05);
        }

        .message-own {
            flex-direction: row-reverse;
        }

        .message-own .message-text {
            background: linear-gradient(135deg, var(--primary), var(--primary-dark));
            color: white;
        }

        .message-reactions {
            display: flex;
            gap: 8px;
            margin-top: 8px;
        }

        .reaction {
            background: var(--light-gray);
            padding: 4px 8px;
            border-radius: 20px;
            font-size: 12px;
            cursor: pointer;
            transition: all 0.2s;
        }

        .reaction:hover {
            background: #e0e7ff;
            transform: scale(1.05);
        }

        /* Input Area */
        .chat-input-area {
            padding: 20px 24px;
            background: white;
            border-top: 1px solid var(--border);
        }

        .input-wrapper {
            display: flex;
            gap: 12px;
            align-items: flex-end;
            background: var(--light-gray);
            border-radius: 16px;
            padding: 12px 16px;
        }

        .input-actions {
            display: flex;
            gap: 8px;
        }

        .action-btn {
            background: none;
            border: none;
            cursor: pointer;
            color: var(--gray);
            padding: 8px;
            border-radius: 8px;
            transition: all 0.2s;
            font-size: 18px;
        }

        .action-btn:hover {
            background: white;
            color: var(--primary);
        }

        .chat-input {
            flex: 1;
            border: none;
            background: none;
            outline: none;
            font-size: 14px;
            resize: none;
            font-family: inherit;
            max-height: 100px;
        }

        .send-btn {
            background: linear-gradient(135deg, var(--primary), var(--primary-dark));
            color: white;
            border: none;
            padding: 8px 20px;
            border-radius: 12px;
            cursor: pointer;
            font-weight: 600;
            transition: all 0.2s;
        }

        .send-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(99,102,241,0.3);
        }

        /* Right Sidebar */
        .right-sidebar {
            width: 260px;
            background: white;
            border-left: 1px solid var(--border);
            display: flex;
            flex-direction: column;
        }

        .right-sidebar-header {
            padding: 20px;
            border-bottom: 1px solid var(--border);
            font-weight: 600;
            color: var(--dark);
        }

        .users-list {
            flex: 1;
            overflow-y: auto;
            padding: 12px;
        }

        .user-item {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 10px 12px;
            margin: 4px 0;
            border-radius: 10px;
            cursor: pointer;
            transition: all 0.2s;
        }

        .user-item:hover {
            background: var(--light-gray);
        }

        .user-avatar {
            width: 32px;
            height: 32px;
            border-radius: 8px;
            background: linear-gradient(135deg, var(--secondary), #059669);
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-weight: 600;
            font-size: 12px;
        }

        .user-info {
            flex: 1;
        }

        .user-name {
            font-size: 14px;
            font-weight: 500;
            color: var(--dark);
        }

        .user-status {
            font-size: 11px;
            color: var(--gray);
        }

        .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: var(--secondary);
            display: inline-block;
            margin-right: 4px;
        }

        .status-dot.offline {
            background: var(--gray);
        }

        .typing-indicator {
            font-size: 12px;
            color: var(--gray);
            font-style: italic;
            padding: 8px 24px;
        }

        /* Scrollbar */
        ::-webkit-scrollbar {
            width: 6px;
            height: 6px;
        }

        ::-webkit-scrollbar-track {
            background: var(--light-gray);
        }

        ::-webkit-scrollbar-thumb {
            background: var(--border);
            border-radius: 3px;
        }

        ::-webkit-scrollbar-thumb:hover {
            background: var(--gray);
        }

        /* Emoji Picker */
        .emoji-picker {
            position: absolute;
            bottom: 80px;
            background: white;
            border-radius: 12px;
            box-shadow: 0 10px 25px -5px rgba(0,0,0,0.1);
            padding: 12px;
            display: none;
            grid-template-columns: repeat(6, 1fr);
            gap: 8px;
            z-index: 1000;
        }

        .emoji-picker.active {
            display: grid;
        }

        .emoji {
            cursor: pointer;
            font-size: 20px;
            padding: 6px;
            text-align: center;
            transition: all 0.2s;
        }

        .emoji:hover {
            transform: scale(1.2);
            background: var(--light-gray);
            border-radius: 8px;
        }

        @media (max-width: 768px) {
            .sidebar, .right-sidebar {
                display: none;
            }
        }
    </style>
</head>
<body>
    <div id="authContainer" class="auth-container">
        <div class="auth-card">
            <h2 id="authTitle">Welcome Back</h2>
            <div>
                <div class="input-group">
                    <input type="text" id="loginUsername" placeholder="Username">
                </div>
                <div class="input-group">
                    <input type="password" id="loginPassword" placeholder="Password">
                </div>
                <button class="btn" onclick="handleAuth()" id="authBtn">Sign In</button>
                <div class="auth-switch">
                    New to Enterprise Pro? <a onclick="toggleAuth()">Create account</a>
                </div>
            </div>
        </div>
    </div>

    <div id="chatContainer" class="chat-container">
        <div class="app-layout">
            <!-- Left Sidebar -->
            <div class="sidebar">
                <div class="sidebar-header">
                    <div class="workspace-name">Enterprise Pro</div>
                    <div class="user-status-small">Team Communication</div>
                </div>
                <div class="nav-menu">
                    <div class="nav-section">
                        <div class="nav-section-title">Channels</div>
                        <div id="roomsList"></div>
                    </div>
                </div>
                <button class="logout-btn" onclick="logout()">
                    <i class="fas fa-sign-out-alt"></i> Sign Out
                </button>
            </div>

            <!-- Chat Main -->
            <div class="chat-main">
                <div class="chat-header">
                    <div class="current-room-info">
                        <div>
                            <div class="current-room-name" id="currentRoomName">General Chat</div>
                            <div class="room-meta" id="roomMeta"># general-channel</div>
                        </div>
                        <div class="search-box">
                            <i class="fas fa-search"></i>
                            <input type="text" id="searchInput" placeholder="Search messages...">
                        </div>
                    </div>
                </div>
                <div class="messages-area" id="messagesArea"></div>
                <div class="typing-indicator" id="typingIndicator"></div>
                <div class="chat-input-area">
                    <div class="input-wrapper">
                        <div class="input-actions">
                            <button class="action-btn" onclick="toggleEmojiPicker()">
                                <i class="far fa-smile-wink"></i>
                            </button>
                            <button class="action-btn">
                                <i class="fas fa-paperclip"></i>
                            </button>
                        </div>
                        <textarea class="chat-input" id="messageInput" placeholder="Type your message..." rows="1" onkeypress="handleKeyPress(event)"></textarea>
                        <button class="send-btn" onclick="sendMessage()">
                            <i class="fas fa-paper-plane"></i> Send
                        </button>
                    </div>
                    <div id="emojiPicker" class="emoji-picker">
                        <div class="emoji" onclick="addEmoji('😀')">😀</div>
                        <div class="emoji" onclick="addEmoji('😂')">😂</div>
                        <div class="emoji" onclick="addEmoji('😍')">😍</div>
                        <div class="emoji" onclick="addEmoji('🎉')">🎉</div>
                        <div class="emoji" onclick="addEmoji('👍')">👍</div>
                        <div class="emoji" onclick="addEmoji('❤️')">❤️</div>
                        <div class="emoji" onclick="addEmoji('🔥')">🔥</div>
                        <div class="emoji" onclick="addEmoji('🚀')">🚀</div>
                        <div class="emoji" onclick="addEmoji('💯')">💯</div>
                        <div class="emoji" onclick="addEmoji('✅')">✅</div>
                    </div>
                </div>
            </div>

            <!-- Right Sidebar -->
            <div class="right-sidebar">
                <div class="right-sidebar-header">
                    <i class="fas fa-users"></i> Team Members
                </div>
                <div class="users-list" id="usersList"></div>
            </div>
        </div>
    </div>

    <script>
        let currentUser = null;
        let currentRoom = 'general';
        let token = null;
        let messageInterval = null;
        let typingTimeout = null;
        let currentMessages = [];

        async function handleAuth() {
            const isLogin = document.getElementById('authTitle').innerText === 'Welcome Back';
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
                if (email && email.includes('@')) {
                    await register(username, email, password);
                } else {
                    alert('Please enter a valid email');
                }
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
                    setupTypingListener();
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
                    setupTypingListener();
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
            
            if (title.innerText === 'Welcome Back') {
                title.innerText = 'Create Account';
                btn.innerText = 'Sign Up';
                switchText.innerHTML = 'Already have an account? <a onclick="toggleAuth()">Sign In</a>';
            } else {
                title.innerText = 'Welcome Back';
                btn.innerText = 'Sign In';
                switchText.innerHTML = 'New to Enterprise Pro? <a onclick="toggleAuth()">Create account</a>';
            }
        }

        function showChat() {
            document.getElementById('authContainer').style.display = 'none';
            document.getElementById('chatContainer').style.display = 'block';
        }

        async function loadMessages(loadMore = false) {
            try {
                let url = '/api/messages?room=' + currentRoom + '&limit=50';
                if (loadMore && currentMessages.length > 0) {
                    url += '&before=' + currentMessages[0].id;
                }
                
                const res = await fetch(url, {
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                const messages = await res.json();
                
                if (loadMore) {
                    currentMessages = [...messages, ...currentMessages];
                } else {
                    currentMessages = messages;
                }
                
                renderMessages();
            } catch (err) {
                console.error('Load messages error:', err);
            }
        }

        function renderMessages() {
            const messagesArea = document.getElementById('messagesArea');
            
            if (currentMessages.length === 0) {
                messagesArea.innerHTML = '<div style="text-align: center; padding: 60px; color: #64748b;"><i class="fas fa-comments" style="font-size: 48px; margin-bottom: 16px; opacity: 0.3;"></i><br>No messages yet. Start the conversation!</div>';
                return;
            }
            
            messagesArea.innerHTML = '';
            let lastDate = null;
            
            currentMessages.forEach(msg => {
                const msgDate = new Date(msg.created_at).toDateString();
                if (lastDate !== msgDate) {
                    const dateDiv = document.createElement('div');
                    dateDiv.style.cssText = 'text-align: center; margin: 16px 0;';
                    dateDiv.innerHTML = '<span style="background: #e2e8f0; padding: 4px 12px; border-radius: 20px; font-size: 12px;">' + msgDate + '</span>';
                    messagesArea.appendChild(dateDiv);
                    lastDate = msgDate;
                }
                
                const messageDiv = document.createElement('div');
                messageDiv.className = 'message-group ' + (msg.user_id === currentUser.id ? 'message-own' : '');
                messageDiv.innerHTML = 
                    '<div class="message-avatar">' + (msg.username.charAt(0).toUpperCase()) + '</div>' +
                    '<div class="message-content">' +
                        '<div class="message-header">' +
                            '<span class="message-sender">' + escapeHtml(msg.username) + '</span>' +
                            '<span class="message-time">' + new Date(msg.created_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) + '</span>' +
                        '</div>' +
                        '<div class="message-text">' + escapeHtml(msg.message) + '</div>' +
                        '<div class="message-reactions" id="reactions-' + msg.id + '"></div>' +
                    '</div>';
                
                messagesArea.appendChild(messageDiv);
                
                // Add reactions if any
                if (msg.reactions) {
                    const reactionsDiv = document.getElementById('reactions-' + msg.id);
                    const reactions = JSON.parse(msg.reactions);
                    for (const [emoji, users] of Object.entries(reactions)) {
                        const reactionSpan = document.createElement('span');
                        reactionSpan.className = 'reaction';
                        reactionSpan.innerHTML = emoji + ' ' + users.length;
                        reactionSpan.onclick = () => addReaction(msg.id, emoji);
                        reactionsDiv.appendChild(reactionSpan);
                    }
                }
            });
            
            messagesArea.scrollTop = messagesArea.scrollHeight;
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

        async function addReaction(messageId, emoji) {
            try {
                await fetch('/api/messages/' + messageId + '/react', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + token
                    },
                    body: JSON.stringify({ reaction: emoji })
                });
                loadMessages();
            } catch (err) {
                console.error('Add reaction error:', err);
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
                
                const icons = {'general': 'hashtag', 'random': 'random', 'tech': 'microchip'};
                
                rooms.forEach(room => {
                    const roomDiv = document.createElement('div');
                    roomDiv.className = 'room-item ' + (room.id === currentRoom ? 'active' : '');
                    roomDiv.innerHTML = '<i class="fas fa-' + (icons[room.id] || 'hashtag') + '"></i><span>' + escapeHtml(room.name) + '</span>';
                    roomDiv.onclick = () => {
                        currentRoom = room.id;
                        document.getElementById('currentRoomName').innerText = room.name;
                        document.getElementById('roomMeta').innerHTML = '# ' + room.id + '-channel';
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
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                const users = await res.json();
                const usersList = document.getElementById('usersList');
                usersList.innerHTML = '';
                users.forEach(user => {
                    if (user.id !== currentUser.id) {
                        const userDiv = document.createElement('div');
                        userDiv.className = 'user-item';
                        userDiv.innerHTML = 
                            '<div class="user-avatar">' + user.username.charAt(0).toUpperCase() + '</div>' +
                            '<div class="user-info">' +
                                '<div class="user-name">' + escapeHtml(user.username) + '</div>' +
                                '<div class="user-status"><span class="status-dot ' + (user.status === 'online' ? '' : 'offline') + '"></span>' + (user.status === 'online' ? 'Online' : 'Offline') + '</div>' +
                            '</div>';
                        usersList.appendChild(userDiv);
                    }
                });
            } catch (err) {
                console.error('Load users error:', err);
            }
        }

        function handleKeyPress(event) {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
            }
            sendTypingIndicator();
        }

        function sendTypingIndicator() {
            if (typingTimeout) clearTimeout(typingTimeout);
            fetch('/api/users/typing', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                },
                body: JSON.stringify({ roomId: currentRoom, typing: true })
            });
            typingTimeout = setTimeout(() => {}, 1000);
        }

        function setupTypingListener() {
            // In production, implement WebSocket for real typing indicators
        }

        function toggleEmojiPicker() {
            const picker = document.getElementById('emojiPicker');
            picker.classList.toggle('active');
        }

        function addEmoji(emoji) {
            const input = document.getElementById('messageInput');
            input.value += emoji;
            input.focus();
            document.getElementById('emojiPicker').classList.remove('active');
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
            }, 2000);
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

        // Search functionality
        document.getElementById('searchInput').addEventListener('input', async (e) => {
            const query = e.target.value;
            if (query.length > 2) {
                const res = await fetch('/api/search?q=' + encodeURIComponent(query), {
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                const results = await res.json();
                console.log('Search results:', results);
            }
        });

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
            setupTypingListener();
        }
    </script>
</body>
</html>`;
  
  return new Response(html, { headers: { 'Content-Type': 'text/html' } });
}
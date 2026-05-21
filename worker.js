export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // Debug log
    console.log("Request received:", url.pathname);
    console.log("DB binding exists?", !!env.DB);

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    // Check database connection
    if (!env.DB) {
      return new Response("Database binding 'DB' not found! Check your wrangler.toml or Dashboard bindings.", 
        { status: 500, headers: cors }
      );
    }

    // Create table if not exists
    try {
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          email TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `).run();
      console.log("✅ Table ensured");
    } catch (err) {
      console.error("Table creation error:", err);
      return new Response("DB Error: " + err.message, { status: 500, headers: cors });
    }

    // Serve HTML
    if (url.pathname === "/") {
      const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Records App</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Arial;background:#0f172a;color:white;padding:20px}
.container{max-width:800px;margin:0 auto}
h1{text-align:center;margin-bottom:30px}
form{display:flex;gap:10px;margin-bottom:20px}
input{flex:1;padding:12px;border-radius:5px;border:none;font-size:16px}
button{padding:12px 20px;background:#38bdf8;border:none;border-radius:5px;cursor:pointer;font-size:16px;font-weight:bold}
button:hover{background:#0ea5e9}
.card{background:#1e293b;margin:10px 0;padding:15px;border-radius:8px;display:flex;justify-content:space-between;align-items:center}
.delete{background:#ef4444;color:white;padding:8px 15px;border-radius:5px;cursor:pointer}
.empty{text-align:center;color:#94a3b8;padding:40px}
</style>
</head>
<body>
<div class="container">
<h1>📝 Records App</h1>
<form id="form">
<input id="name" placeholder="Full Name" required>
<input id="email" placeholder="Email Address" required>
<button type="submit">Add Record</button>
</form>
<div id="list">Loading...</div>
</div>
<script>
const API = "/api/records";
async function load(){
  try {
    const res = await fetch(API);
    if(!res.ok) throw new Error(await res.text());
    const data = await res.json();
    const list = document.getElementById("list");
    if(data.length === 0) {
      list.innerHTML = '<div class="empty">✨ No records yet. Add your first record!</div>';
      return;
    }
    list.innerHTML = "";
    data.forEach(r=>{
      const div = document.createElement("div");
      div.className = "card";
      div.innerHTML = \`
        <div><strong>\${escapeHtml(r.name)}</strong><br><small>\${escapeHtml(r.email)}</small></div>
        <button class="delete" onclick="del(\${r.id})\">Delete</button>
      \`;
      list.appendChild(div);
    });
  } catch(e) {
    document.getElementById("list").innerHTML = '<div class="empty">❌ Error: ' + e.message + '</div>';
  }
}
function escapeHtml(str) { return str.replace(/[&<>]/g, function(m){return m==='&'?'&amp;':m==='<'?'&lt;':'&gt;';});}
async function del(id){ if(confirm("Delete?")){ await fetch(API+"/"+id,{method:"DELETE"}); load(); } }
document.getElementById("form").onsubmit = async(e)=>{
  e.preventDefault();
  await fetch(API,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:name.value,email:email.value})});
  name.value=""; email.value="";
  load();
}
load();
</script>
</body>
</html>`;
      return new Response(html, { headers: { "Content-Type": "text/html", ...cors } });
    }

    // API Routes
    if (url.pathname === "/api/records" && request.method === "GET") {
      try {
        const data = await env.DB.prepare("SELECT * FROM records ORDER BY id DESC").all();
        return Response.json(data.results, { headers: cors });
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500, headers: cors });
      }
    }

    if (url.pathname === "/api/records" && request.method === "POST") {
      const body = await request.json();
      await env.DB.prepare("INSERT INTO records (name, email) VALUES (?, ?)")
        .bind(body.name, body.email)
        .run();
      return Response.json({ success: true }, { headers: cors });
    }

    if (url.pathname.startsWith("/api/records/") && request.method === "DELETE") {
      const id = url.pathname.split("/").pop();
      await env.DB.prepare("DELETE FROM records WHERE id=?")
        .bind(id)
        .run();
      return Response.json({ success: true }, { headers: cors });
    }

    return new Response("Not Found", { status: 404 });
  },
};
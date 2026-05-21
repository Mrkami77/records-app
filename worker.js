export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    if (url.pathname === "/api/records" && request.method === "GET") {
      const data = await env.DB.prepare(
        "SELECT * FROM records ORDER BY id DESC"
      ).all();
      return Response.json(data.results, { headers: cors });
    }

    if (url.pathname === "/api/records" && request.method === "POST") {
      const body = await request.json();

      await env.DB.prepare(
        "INSERT INTO records (name, email) VALUES (?, ?)"
      )
        .bind(body.name, body.email)
        .run();

      return Response.json({ success: true }, { headers: cors });
    }

    if (url.pathname.startsWith("/api/records/")) {
      const id = url.pathname.split("/").pop();

      await env.DB.prepare("DELETE FROM records WHERE id=?")
        .bind(id)
        .run();

      return Response.json({ success: true }, { headers: cors });
    }

    return new Response("Not Found", { status: 404 });
  },
};
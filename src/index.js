const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const unauthorized = () =>
  new Response("認証が必要です", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="My Task", charset="UTF-8"' },
  });

// APP_PASSWORD が設定されている場合のみ Basic 認証を要求する（ユーザー名は任意）
function authorized(request, env) {
  if (!env.APP_PASSWORD) return true;
  const header = request.headers.get("authorization") || "";
  if (!header.startsWith("Basic ")) return false;
  let decoded;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return false;
  }
  const password = decoded.slice(decoded.indexOf(":") + 1);
  return password === env.APP_PASSWORD;
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function handleApi(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/api/tasks" && method === "GET") {
    const date = url.searchParams.get("date");
    if (!DATE_RE.test(date || "")) return json({ error: "date が不正です" }, 400);
    const { results } = await env.DB.prepare(
      "SELECT id, date, title, done, position FROM tasks WHERE date = ? ORDER BY done, position, id"
    )
      .bind(date)
      .all();
    return json({ tasks: results });
  }

  if (pathname === "/api/tasks" && method === "POST") {
    const body = await readBody(request);
    const title = String(body?.title ?? "").trim().slice(0, 200);
    if (!title || !DATE_RE.test(body?.date || "")) {
      return json({ error: "title と date が必要です" }, 400);
    }
    const row = await env.DB.prepare(
      `INSERT INTO tasks (date, title, position)
       VALUES (?1, ?2, COALESCE((SELECT MAX(position) + 1 FROM tasks WHERE date = ?1), 0))
       RETURNING id, date, title, done, position`
    )
      .bind(body.date, title)
      .first();
    return json({ task: row }, 201);
  }

  if (pathname === "/api/carryover" && method === "POST") {
    const body = await readBody(request);
    if (!DATE_RE.test(body?.from || "") || !DATE_RE.test(body?.to || "") || body.from === body.to) {
      return json({ error: "from と to が不正です" }, 400);
    }
    const res = await env.DB.prepare(
      `UPDATE tasks
       SET date = ?2,
           position = position + COALESCE((SELECT MAX(position) + 1 FROM tasks WHERE date = ?2), 0)
       WHERE date = ?1 AND done = 0`
    )
      .bind(body.from, body.to)
      .run();
    return json({ moved: res.meta.changes });
  }

  const m = pathname.match(/^\/api\/tasks\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);

    if (method === "PATCH") {
      const body = await readBody(request);
      if (!body) return json({ error: "不正なリクエスト" }, 400);
      const sets = [];
      const binds = [];
      if (typeof body.done === "boolean") {
        sets.push("done = ?", "done_at = " + (body.done ? "datetime('now')" : "NULL"));
        binds.push(body.done ? 1 : 0);
      }
      if (typeof body.title === "string") {
        const title = body.title.trim().slice(0, 200);
        if (!title) return json({ error: "title が空です" }, 400);
        sets.push("title = ?");
        binds.push(title);
      }
      if (!sets.length) return json({ error: "更新項目がありません" }, 400);
      const row = await env.DB.prepare(
        `UPDATE tasks SET ${sets.join(", ")} WHERE id = ? RETURNING id, date, title, done, position`
      )
        .bind(...binds, id)
        .first();
      return row ? json({ task: row }) : json({ error: "見つかりません" }, 404);
    }

    if (method === "DELETE") {
      const res = await env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(id).run();
      return res.meta.changes ? json({ ok: true }) : json({ error: "見つかりません" }, 404);
    }
  }

  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request, env) {
    if (!authorized(request, env)) return unauthorized();
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (e) {
        console.error(e);
        return json({ error: "サーバーエラー" }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};

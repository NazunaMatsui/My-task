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


// ---- 天気（Open-Meteo）とニュース（RSS） ----
const WEATHER_CODES = [
  [[0], "快晴", "☀️"], [[1], "晴れ", "🌤️"], [[2], "くもり時々晴れ", "⛅"], [[3], "くもり", "☁️"],
  [[45, 48], "霧", "🌫️"], [[51, 53, 55, 56, 57], "霧雨", "🌦️"],
  [[61, 63, 65, 66, 67, 80, 81, 82], "雨", "🌧️"], [[71, 73, 75, 77, 85, 86], "雪", "❄️"],
  [[95, 96, 99], "雷雨", "⛈️"],
];

function describeWeather(code) {
  const hit = WEATHER_CODES.find(([codes]) => codes.includes(code));
  return hit ? { label: hit[1], icon: hit[2] } : { label: "不明", icon: "❓" };
}

async function handleWeather(env) {
  const lat = env.WEATHER_LAT || "35.6812";
  const lon = env.WEATHER_LON || "139.7671";
  const api =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    "&current=temperature_2m,weather_code" +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
    "&timezone=Asia%2FTokyo&forecast_days=1";
  const res = await fetch(api, { cf: { cacheTtl: 900, cacheEverything: true } });
  if (!res.ok) return json({ error: "天気を取得できませんでした" }, 502);
  const d = await res.json();
  return json({
    place: env.WEATHER_LABEL || "東京",
    ...describeWeather(d.daily.weather_code[0]),
    temp: Math.round(d.current.temperature_2m),
    max: Math.round(d.daily.temperature_2m_max[0]),
    min: Math.round(d.daily.temperature_2m_min[0]),
    rain: d.daily.precipitation_probability_max[0],
  });
}

const decodeXml = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();

export function parseRss(xml, limit = 5) {
  const items = [];
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)) {
    const pick = (tag) => {
      const t = m[0].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return t ? decodeXml(t[1]) : "";
    };
    const title = pick("title");
    const link = pick("link");
    if (title && /^https?:\/\//.test(link)) items.push({ title, link, date: pick("pubDate") });
    if (items.length >= limit) break;
  }
  return items;
}

async function handleNews(env) {
  const feed = env.NEWS_FEED_URL || "https://www3.nhk.or.jp/rss/news/cat0.xml";
  const res = await fetch(feed, { cf: { cacheTtl: 600, cacheEverything: true } });
  if (!res.ok) return json({ error: "ニュースを取得できませんでした" }, 502);
  return json({ items: parseRss(await res.text()) });
}

async function handleApi(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/api/weather" && method === "GET") return handleWeather(env);
  if (pathname === "/api/news" && method === "GET") return handleNews(env);

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

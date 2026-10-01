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
  [[0], "快晴", "sun"], [[1], "晴れ", "sun"], [[2], "くもり時々晴れ", "partly"], [[3], "くもり", "cloud"],
  [[45, 48], "霧", "fog"], [[51, 53, 55, 56, 57], "霧雨", "rain"],
  [[61, 63, 65, 66, 67, 80, 81, 82], "雨", "rain"], [[71, 73, 75, 77, 85, 86], "雪", "snow"],
  [[95, 96, 99], "雷雨", "thunder"],
];

function describeWeather(code) {
  const hit = WEATHER_CODES.find(([codes]) => codes.includes(code));
  return hit ? { label: hit[1], kind: hit[2] } : { label: "不明", kind: "cloud" };
}

const CITIES = [
  { name: "姫路市", lat: 34.8151, lon: 134.6853 },
  { name: "宍粟市", lat: 35.0042, lon: 134.5486 },
  { name: "神戸市", lat: 34.6901, lon: 135.1956 },
];

async function fetchCityWeather(city) {
  const api =
    `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}` +
    "&current=temperature_2m,weather_code,apparent_temperature,relative_humidity_2m,wind_speed_10m" +
    "&hourly=temperature_2m,precipitation_probability,weather_code" +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,uv_index_max" +
    "&timezone=Asia%2FTokyo&forecast_days=3";
  const res = await fetch(api, { cf: { cacheTtl: 900, cacheEverything: true } });
  if (!res.ok) throw new Error(`weather ${res.status}`);
  const d = await res.json();
  const day = (i) => ({
    date: d.daily.time[i],
    ...describeWeather(d.daily.weather_code[i]),
    max: Math.round(d.daily.temperature_2m_max[i]),
    min: Math.round(d.daily.temperature_2m_min[i]),
    rain: d.daily.precipitation_probability_max[i],
  });
  // 今日の 6時〜21時 を3時間おき
  const hours = [6, 9, 12, 15, 18, 21].map((h) => ({
    hour: h,
    temp: Math.round(d.hourly.temperature_2m[h]),
    rain: d.hourly.precipitation_probability[h],
    kind: describeWeather(d.hourly.weather_code[h]).kind,
  }));
  return {
    place: city.name,
    ...day(0),
    temp: Math.round(d.current.temperature_2m),
    feels: Math.round(d.current.apparent_temperature),
    humidity: d.current.relative_humidity_2m,
    wind: Math.round(d.current.wind_speed_10m),
    uv: Math.round(d.daily.uv_index_max[0]),
    sunrise: d.daily.sunrise[0].slice(11, 16),
    sunset: d.daily.sunset[0].slice(11, 16),
    hours,
    days: [day(1), day(2)],
  };
}

async function handleWeather() {
  // 1都市の失敗で全体を落とさない
  const results = await Promise.allSettled(CITIES.map(fetchCityWeather));
  const cities = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  if (!cities.length) return json({ error: "天気を取得できませんでした" }, 502);
  return json({ cities });
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
    const date = pick("pubDate") || pick("dc:date");
    if (title && /^https?:\/\//.test(link)) items.push({ title, link, date });
    if (items.length >= limit) break;
  }
  return items;
}

const NEWS_CATEGORIES = {
  entertainment: {
    label: "エンタメ",
    feeds: ["https://www3.nhk.or.jp/rss/news/cat2.xml"],
  },
  it: {
    label: "IT",
    feeds: ["https://rss.itmedia.co.jp/rss/2.0/news_bursts.xml"],
  },
  business: {
    label: "政治・経済",
    feeds: [
      "https://www3.nhk.or.jp/rss/news/cat4.xml",
      "https://www3.nhk.or.jp/rss/news/cat5.xml",
    ],
  },
  love: {
    label: "恋愛",
    feeds: [
      "https://news.google.com/rss/search?q=" +
        encodeURIComponent("恋愛") +
        "&hl=ja&gl=JP&ceid=JP:ja",
    ],
  },
};

async function fetchFeed(url) {
  const res = await fetch(url, { cf: { cacheTtl: 120, cacheEverything: true } });
  if (!res.ok) throw new Error(`feed ${res.status}`);
  return parseRss(await res.text(), 8);
}

async function handleNews(url) {
  const cat = NEWS_CATEGORIES[url.searchParams.get("cat") || "entertainment"];
  if (!cat) return json({ error: "cat が不正です" }, 400);
  const results = await Promise.allSettled(cat.feeds.map(fetchFeed));
  const items = results
    .filter((r) => r.status === "fulfilled")
    .flatMap((r) => r.value)
    .sort((x, y) => (Date.parse(y.date) || 0) - (Date.parse(x.date) || 0))
    .slice(0, 8);
  if (!items.length) return json({ error: "ニュースを取得できませんでした" }, 502);
  return json({ items });
}

async function handleApi(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/api/weather" && method === "GET") return handleWeather();
  if (pathname === "/api/news" && method === "GET") return handleNews(url);

  if (pathname === "/api/summary" && method === "GET") {
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (!DATE_RE.test(from || "") || !DATE_RE.test(to || "")) return json({ error: "from / to が不正です" }, 400);
    const { results } = await env.DB.prepare(
      "SELECT date, COUNT(*) AS total, SUM(done) AS done FROM tasks WHERE date BETWEEN ? AND ? GROUP BY date"
    )
      .bind(from, to)
      .all();
    return json({ days: results });
  }

  if (pathname === "/api/search" && method === "GET") {
    const q = (url.searchParams.get("q") || "").trim().slice(0, 50);
    if (!q) return json({ tasks: [] });
    const like = "%" + q.replace(/[\\%_]/g, "\\$&") + "%";
    const { results } = await env.DB.prepare(
      "SELECT id, date, title, done FROM tasks WHERE title LIKE ? ESCAPE '\\' ORDER BY date DESC, id DESC LIMIT 15"
    )
      .bind(like)
      .all();
    return json({ tasks: results });
  }

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

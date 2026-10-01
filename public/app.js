"use strict";

const $ = (id) => document.getElementById(id);
const WEEK = ["日", "月", "火", "水", "木", "金", "土"];
const RING_LEN = 2 * Math.PI * 50;

// 日本時間の YYYY-MM-DD
const jstToday = () =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());

function shiftDate(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function formatDate(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const w = WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}月${d}日（${w}）`;
}

let current = jstToday();
let tasks = [];

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

function showError(e) {
  const el = $("error");
  el.textContent = e ? `エラー: ${e.message}` : "";
  el.hidden = !e;
}

async function guard(fn) {
  try {
    showError(null);
    await fn();
  } catch (e) {
    showError(e);
  }
}

async function load() {
  const { tasks: rows } = await api(`/api/tasks?date=${current}`);
  tasks = rows;
  render();
  updateCarry();
  refreshSummary();
}

async function updateCarry() {
  const btn = $("carry");
  const prev = shiftDate(current, -1);
  try {
    const { tasks: rows } = await api(`/api/tasks?date=${prev}`);
    const n = rows.filter((t) => !t.done).length;
    btn.hidden = n === 0;
    btn.textContent = `前日の未完了 ${n} 件を持ってくる`;
  } catch {
    btn.hidden = true;
  }
}

function render() {
  $("dateLabel").textContent = formatDate(current);
  $("today").hidden = current === jstToday();
  $("kicker").textContent = current === jstToday() ? "TODAY" : current < jstToday() ? "PAST" : "UPCOMING";

  const list = $("list");
  list.replaceChildren();
  for (const t of tasks) {
    const li = document.createElement("li");
    li.className = "item" + (t.done ? " done" : "");

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!t.done;
    cb.setAttribute("aria-label", "完了");
    cb.addEventListener("change", () => {
      if (cb.checked) {
        const r = cb.getBoundingClientRect();
        burst(r.left + r.width / 2, r.top + r.height / 2);
      }
      guard(async () => {
        await api(`/api/tasks/${t.id}`, { method: "PATCH", body: { done: cb.checked } });
        await load();
      });
    });

    const title = document.createElement("span");
    title.className = "title";
    title.textContent = t.title;
    title.title = "クリックで編集";
    title.addEventListener("click", () => startEdit(t, title));

    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "×";
    del.setAttribute("aria-label", "削除");
    del.addEventListener("click", () =>
      guard(async () => {
        await api(`/api/tasks/${t.id}`, { method: "DELETE" });
        await load();
      })
    );

    li.append(cb, title, del);
    list.append(li);
  }

  const done = tasks.filter((t) => t.done).length;
  $("empty").hidden = tasks.length > 0;
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  $("ringFg").style.strokeDashoffset = String(RING_LEN * (1 - pct / 100));
  $("ringPct").textContent = `${pct}%`;
  $("statDone").textContent = String(done);
  $("statLeft").textContent = String(tasks.length - done);
  $("progressText").textContent = progressMessage(done, tasks.length) || "タスクなし";
}

function progressMessage(done, total) {
  if (!total) return "";
  if (done === total) return `すべて完了（${done} / ${total}）`;
  if (done === 0) return `未着手（0 / ${total}）`;
  return `あと${total - done}件（${done} / ${total}）`;
}

// 完了したときの演出（動きを減らす設定の人には出さない）
function burst(x, y, count = 12) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const colors = ["#4a3fb5", "#e8703a", "#1f9d72", "#2f6fd6"];
  const fx = $("fx");
  for (let i = 0; i < count; i++) {
    const p = el("span", "confetti");
    const angle = Math.random() * Math.PI * 2;
    const dist = 40 + Math.random() * 80;
    p.style.left = `${x}px`;
    p.style.top = `${y}px`;
    p.style.background = colors[i % colors.length];
    p.style.setProperty("--dx", `${Math.cos(angle) * dist}px`);
    p.style.setProperty("--dy", `${Math.sin(angle) * dist - 30}px`);
    p.style.setProperty("--rot", `${Math.random() * 360}deg`);
    fx.append(p);
    setTimeout(() => p.remove(), 1200);
  }
}

function startEdit(task, span) {
  const input = document.createElement("input");
  input.className = "edit";
  input.maxLength = 200;
  input.value = task.title;
  span.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = (save) => {
    if (finished) return;
    finished = true;
    const next = input.value.trim();
    if (save && next && next !== task.title) {
      guard(async () => {
        await api(`/api/tasks/${task.id}`, { method: "PATCH", body: { title: next } });
        await load();
      });
    } else {
      render();
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

function go(date) {
  current = date;
  calMonth = date.slice(0, 7);
  guard(load);
}

// ---- ダッシュボード（カレンダー・週間グラフ・検索） ----
let calMonth = current.slice(0, 7); // YYYY-MM
let summary = {}; // date -> { total, done }

const svgEl = (tag, attrs = {}, text) => {
  const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
};

function calGridStart() {
  const [y, m] = calMonth.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  return shiftDate(first.toISOString().slice(0, 10), -first.getUTCDay());
}

async function refreshSummary() {
  const start = calGridStart();
  const from = [start, shiftDate(current, -6)].sort()[0];
  const to = [shiftDate(start, 41), current].sort().pop();
  try {
    const { days } = await api(`/api/summary?from=${from}&to=${to}`);
    summary = Object.fromEntries(days.map((d) => [d.date, { total: d.total, done: d.done || 0 }]));
  } catch {
    summary = {};
  }
  renderCalendar();
  renderWeek();
}

function renderCalendar() {
  const [y, m] = calMonth.split("-").map(Number);
  $("calTitle").textContent = `${y}年${m}月`;
  const grid = $("calGrid");
  grid.replaceChildren(...WEEK.map((w) => el("div", "dow", w)));
  const start = calGridStart();
  const today = jstToday();
  for (let i = 0; i < 42; i++) {
    const date = shiftDate(start, i);
    const btn = el("button", "day", String(Number(date.slice(8))));
    btn.type = "button";
    btn.setAttribute("aria-label", formatDate(date));
    if (!date.startsWith(calMonth)) btn.classList.add("other");
    if (date === today) btn.classList.add("is-today");
    if (date === current) btn.classList.add("selected");
    const info = summary[date];
    if (info && info.total > 0) {
      const dot = el("i");
      if (info.done === info.total) dot.className = "all-done";
      btn.append(dot);
    }
    btn.addEventListener("click", () => go(date));
    grid.append(btn);
  }
}

function renderWeek() {
  const svg = $("weekChart");
  svg.replaceChildren();
  const days = Array.from({ length: 7 }, (_, i) => shiftDate(current, i - 6));
  const rows = days.map((d) => summary[d] || { total: 0, done: 0 });
  const max = Math.max(4, ...rows.map((r) => r.total));
  const top = 14, base = 140, h = base - top;
  for (const f of [0.5, 1]) {
    const y = base - h * f;
    svg.append(svgEl("line", { x1: 10, x2: 290, y1: y, y2: y, class: "axis" }));
    svg.append(svgEl("text", { x: 2, y: y + 3, "font-size": 8 }, String(Math.round(max * f))));
  }
  svg.append(svgEl("line", { x1: 10, x2: 290, y1: base, y2: base, class: "axis" }));
  const slot = 280 / 7;
  rows.forEach((r, i) => {
    const cx = 10 + slot * i + slot / 2;
    const bw = 11;
    for (const [k, cls, dx] of [["total", "bar-all", -bw - 1], ["done", "bar-dn", 1]]) {
      const bh = (r[k] / max) * h;
      svg.append(svgEl("rect", { x: cx + dx, y: base - bh, width: bw, height: bh, rx: 3, class: cls }));
    }
    const d = days[i];
    const label = svgEl("text", { x: cx, y: 156, "text-anchor": "middle", class: d === current ? "sel" : "" }, WEEK[new Date(d + "T00:00:00Z").getUTCDay()]);
    svg.append(label);
    svg.append(svgEl("text", { x: cx, y: 167, "text-anchor": "middle", "font-size": 8 }, String(Number(d.slice(8)))));
  });
}

$("calPrev").addEventListener("click", () => shiftMonth(-1));
$("calNext").addEventListener("click", () => shiftMonth(1));
function shiftMonth(n) {
  const [y, m] = calMonth.split("-").map(Number);
  calMonth = new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
  refreshSummary();
}

// 検索
let searchTimer;
const results = $("searchResults");
function closeSearch() {
  results.hidden = true;
  results.replaceChildren();
}
$("searchInput").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (!q) return closeSearch();
  searchTimer = setTimeout(async () => {
    try {
      const { tasks: found } = await api(`/api/search?q=${encodeURIComponent(q)}`);
      if ($("searchInput").value.trim() !== q) return;
      results.replaceChildren(
        ...(found.length
          ? found.map((t) => {
              const li = el("li");
              const b = el("button");
              b.type = "button";
              if (t.done) b.append(el("span", "tag", "済"));
              b.append(t.title);
              b.append(el("small", "", formatDate(t.date)));
              b.addEventListener("click", () => {
                $("searchInput").value = "";
                closeSearch();
                go(t.date);
              });
              li.append(b);
              return li;
            })
          : [Object.assign(el("li", "none", "見つかりませんでした"))])
      );
      results.hidden = false;
    } catch {
      closeSearch();
    }
  }, 250);
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".search")) closeSearch();
});

// サイドバー: 各セクションへスクロール
for (const btn of document.querySelectorAll(".side-btn")) {
  btn.addEventListener("click", () => {
    document.getElementById(btn.dataset.target)?.scrollIntoView({ behavior: "smooth", block: "start" });
    for (const b of document.querySelectorAll(".side-btn")) b.classList.toggle("active", b === btn);
  });
}

// 天気とニュースは補助情報。失敗してもリスト本体には影響させない
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

// 天気アイコン（線画SVG。固定の文字列のみを使用）
const WX_ICONS = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
  partly: '<circle cx="8" cy="8" r="3"/><path d="M8 2v1M2 8h1M3.8 3.8l.7.7M12.2 3.8l-.7.7"/><path d="M8 20h9a3.5 3.5 0 0 0 .4-6.98A5 5 0 0 0 8 13a3.5 3.5 0 0 0 0 7z"/>',
  cloud: '<path d="M7 19h10a4 4 0 0 0 .5-7.97A5.5 5.5 0 0 0 7 10.5 4.25 4.25 0 0 0 7 19z"/>',
  fog: '<path d="M7 14h10a4 4 0 0 0 .5-7.97A5.5 5.5 0 0 0 7 5.5 4.25 4.25 0 0 0 7 14z"/><path d="M5 18h14M8 21h8"/>',
  rain: '<path d="M7 14h10a4 4 0 0 0 .5-7.97A5.5 5.5 0 0 0 7 5.5 4.25 4.25 0 0 0 7 14z"/><path d="M8 17l-1 3M12 17l-1 3M16 17l-1 3"/>',
  snow: '<path d="M7 14h10a4 4 0 0 0 .5-7.97A5.5 5.5 0 0 0 7 5.5 4.25 4.25 0 0 0 7 14z"/><path d="M8 18v.01M12 18v.01M16 18v.01M10 21v.01M14 21v.01"/>',
  thunder: '<path d="M7 14h10a4 4 0 0 0 .5-7.97A5.5 5.5 0 0 0 7 5.5 4.25 4.25 0 0 0 7 14z"/><path d="M12 14l-2 4h4l-2 4"/>',
};

function wxIcon(kind) {
  const span = el("span", `wx ${kind}`);
  span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${WX_ICONS[kind] || WX_ICONS.cloud}</svg>`;
  return span;
}

let weatherCities = [];
let openCity = null;

function renderWeather() {
  const box = $("weather");
  box.replaceChildren(
    ...weatherCities.map((c) => {
      const card = el("button", "card");
      card.type = "button";
      card.setAttribute("aria-expanded", String(openCity === c.place));
      card.append(
        el("div", "place", c.place),
        wxIcon(c.kind),
        el("div", "main", `${c.label} ${c.temp}℃`),
        el("div", "sub", `${c.max}° / ${c.min}°`),
        el("div", "sub", `降水 ${c.rain}%`),
        el("div", "tap", "タップで詳細")
      );
      card.addEventListener("click", () => {
        openCity = openCity === c.place ? null : c.place;
        renderWeather();
      });
      return card;
    })
  );
  box.hidden = weatherCities.length === 0;
  renderDetail();
}

function fact(value, label) {
  const f = el("div", "fact");
  f.append(el("b", "", value), el("span", "", label));
  return f;
}

function renderDetail() {
  const box = $("weatherDetail");
  const c = weatherCities.find((x) => x.place === openCity);
  box.hidden = !c;
  if (!c) return;

  const title = el("h3");
  const close = el("button", "", "×");
  close.type = "button";
  close.setAttribute("aria-label", "閉じる");
  close.addEventListener("click", () => {
    openCity = null;
    renderWeather();
  });
  title.append(wxIcon(c.kind), `${c.place}の天気`, close);

  const facts = el("div", "facts");
  facts.append(
    fact(`${c.feels}℃`, "体感"),
    fact(`${c.humidity}%`, "湿度"),
    fact(`${c.wind}km/h`, "風速"),
    fact(c.sunrise, "日の出"),
    fact(c.sunset, "日の入"),
    fact(`${c.uv}`, "UV指数")
  );

  const hours = el("div", "hours");
  for (const h of c.hours) {
    const col = el("div");
    col.append(el("div", "h", `${h.hour}時`), wxIcon(h.kind), el("div", "t", `${h.temp}°`), el("div", "r", `${h.rain}%`));
    hours.append(col);
  }

  const days = el("div", "days");
  c.days.forEach((d, i) => {
    const row = el("div");
    row.append(
      el("span", "d", i === 0 ? "明日" : "明後日"),
      wxIcon(d.kind),
      el("span", "l", d.label),
      el("span", "", `${d.max}° / ${d.min}°`),
      el("span", "r", `降水 ${d.rain}%`)
    );
    days.append(row);
  });

  box.replaceChildren(title, facts, hours, days);
}

async function loadWeather() {
  try {
    const { cities } = await api("/api/weather");
    weatherCities = cities;
    renderWeather();
  } catch {}
}

let newsCat = "entertainment";
let newsSeq = 0;
const seenLinks = {}; // カテゴリごとに既読リンクを覚えて、新着にNEWを付ける
const NEWS_REFRESH_MS = 3 * 60 * 1000;

function timeAgo(dateStr) {
  const t = Date.parse(dateStr);
  if (!t) return "";
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 1) return "たった今";
  if (min < 60) return `${min}分前`;
  if (min < 60 * 24) return `${Math.floor(min / 60)}時間前`;
  return `${Math.floor(min / 1440)}日前`;
}

async function loadNews({ silent = false } = {}) {
  const seq = ++newsSeq;
  const cat = newsCat;
  const ul = $("news");
  const msg = $("newsMsg");
  const refresh = $("newsRefresh");
  refresh.classList.add("spin");
  if (!silent) {
    msg.hidden = false;
    msg.textContent = "読み込み中…";
    ul.replaceChildren();
  }
  try {
    const { items } = await api(`/api/news?cat=${cat}`);
    if (seq !== newsSeq) return;
    msg.hidden = items.length > 0;
    msg.textContent = "今日のニュースはまだありません";
    const seen = seenLinks[cat];
    ul.replaceChildren(
      ...items.map((n) => {
        const a = el("a");
        if (seen && !seen.has(n.link)) a.append(el("span", "badge", "NEW"));
        a.append(n.title, el("span", "meta", timeAgo(n.date)));
        a.href = n.link;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        const li = el("li");
        li.append(a);
        return li;
      })
    );
    seenLinks[cat] = new Set(items.map((n) => n.link));
    $("newsUpdated").textContent =
      "更新 " + new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
  } catch {
    if (seq !== newsSeq) return;
    if (!silent) msg.textContent = "ニュースを取得できませんでした";
  } finally {
    if (seq === newsSeq) refresh.classList.remove("spin");
  }
}

$("newsRefresh").addEventListener("click", () => loadNews({ silent: true }));
setInterval(() => {
  if (!document.hidden) loadNews({ silent: true });
}, NEWS_REFRESH_MS);

$("newsTabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-cat]");
  if (!btn || btn.dataset.cat === newsCat) return;
  newsCat = btn.dataset.cat;
  for (const b of $("newsTabs").children) b.setAttribute("aria-selected", String(b === btn));
  loadNews();
});

$("prev").addEventListener("click", () => go(shiftDate(current, -1)));
$("next").addEventListener("click", () => go(shiftDate(current, 1)));
$("today").addEventListener("click", () => go(jstToday()));

$("addForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("addInput");
  const title = input.value.trim();
  if (!title) return;
  input.value = "";
  guard(async () => {
    await api("/api/tasks", { method: "POST", body: { title, date: current } });
    await load();
  });
});

$("carry").addEventListener("click", () =>
  guard(async () => {
    await api("/api/carryover", { method: "POST", body: { from: shiftDate(current, -1), to: current } });
    await load();
  })
);

// 日付をまたいで開きっぱなしの場合、タブに戻ったときに最新を取得
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    guard(load);
    loadNews({ silent: true });
  }
});

guard(load);
loadWeather();
loadNews();

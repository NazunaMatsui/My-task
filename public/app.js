"use strict";

const $ = (id) => document.getElementById(id);
const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

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

  const list = $("list");
  list.replaceChildren();
  for (const t of tasks) {
    const li = document.createElement("li");
    li.className = "item" + (t.done ? " done" : "");

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!t.done;
    cb.setAttribute("aria-label", "完了");
    cb.addEventListener("change", () =>
      guard(async () => {
        await api(`/api/tasks/${t.id}`, { method: "PATCH", body: { done: cb.checked } });
        await load();
      })
    );

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
  $("barFill").style.width = tasks.length ? `${(done / tasks.length) * 100}%` : "0";
  $("progressText").textContent = tasks.length
    ? done === tasks.length
      ? `全部完了！ ${done} / ${tasks.length}`
      : `${done} / ${tasks.length} 完了`
    : "";
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
  // 天気とニュースは補助情報。失敗してもリスト本体には影響させない
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

async function loadWeather() {
  try {
    const { cities } = await api("/api/weather");
    const box = $("weather");
    box.replaceChildren(
      ...cities.map((c) => {
        const card = el("div", "card");
        card.append(
          el("div", "place", c.place),
          el("div", "icon", c.icon),
          el("div", "main", `${c.label} ${c.temp}℃`),
          el("div", "sub", `${c.max}° / ${c.min}°　☔${c.rain}%`)
        );
        return card;
      })
    );
    box.hidden = false;
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
    msg.hidden = true;
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

guard(load);
loadWeather();
loadNews();
}

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

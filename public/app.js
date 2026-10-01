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
async function loadExtras() {
  try {
    const w = await api("/api/weather");
    const box = $("weather");
    box.replaceChildren();
    const icon = document.createElement("span");
    icon.className = "icon";
    icon.textContent = w.icon;
    const text = document.createElement("div");
    const main = document.createElement("div");
    main.className = "main";
    main.textContent = `${w.place}　${w.label}　${w.temp}℃`;
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = `最高 ${w.max}℃ / 最低 ${w.min}℃ / 降水確率 ${w.rain}%`;
    text.append(main, sub);
    box.append(icon, text);
    box.hidden = false;
  } catch {}
  try {
    const { items } = await api("/api/news");
    const ul = $("news");
    ul.replaceChildren();
    for (const n of items) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = n.link;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = n.title;
      li.append(a);
      ul.append(li);
    }
    $("newsBox").hidden = items.length === 0;
  } catch {}
}

guard(load);
loadExtras();
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
  if (!document.hidden) guard(load);
});

guard(load);

"use strict";

// ---------- 共通 ----------
const $ = (id) => document.getElementById(id);

// DOM作成（本文は textContent で入れるため、取得した文章がHTMLとして解釈されることはない）
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "value") e.value = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : String(kid));
  return e;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || "GET",
    headers: { "content-type": "application/json" },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function showError(e) {
  const el = $("boardError");
  el.textContent = e ? `エラー: ${e.message}` : "";
  el.hidden = !e;
}
async function act(fn) {
  try {
    showError(null);
    await fn();
  } catch (e) {
    showError(e);
  }
}

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];
function fmtDate(ymd) {
  if (!ymd) return "";
  const [y, m, d] = ymd.split("-").map(Number);
  return `${m}/${d}（${WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}）`;
}
function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(d);
}
function ago(iso) {
  if (!iso) return "";
  const min = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (min < 1) return "たった今";
  if (min < 60) return `${min}分前`;
  if (min < 1440) return `${Math.floor(min / 60)}時間前`;
  return `${Math.floor(min / 1440)}日前`;
}

const PHASE = {
  preparing: "準備中", in_progress: "進行中", review_pending: "確認待ち（社内）", client_pending: "先方確認待ち",
  material_pending: "素材待ち", permission_pending: "権限待ち", stopped: "停止中", done: "完了",
};
const WAIT = { client: "先方確認待ち", material: "素材待ち", permission: "権限待ち", internal: "社内待ち" };
const STATUS = { open: "未着手", in_progress: "進行中", waiting: "待ち", done: "完了", cancelled: "取消", on_hold: "保留" };
const PROJECT_STATUS = { active: "稼働中", paused: "休止", done: "完了", unknown: "未設定" };
const HEALTH = {
  ok: ["正常", "green"], partial: ["一部失敗", "orange"], failed: ["同期失敗", "red"], stale: ["情報が古い", "orange"],
  never: ["未同期", "muted"], disabled: ["無効", "muted"],
};
const ORIGIN = { ai_extracted: "AI抽出", manual: "手動", adopted_suggestion: "提案から採用" };

let BOARD = null;

// ---------- 根拠の表示 ----------
function evidenceList(list) {
  if (!list || !list.length) return h("p", { class: "empty-mini" }, "根拠の記録がありません");
  return h("ul", {}, list.map((e) => h("li", {},
    h("span", { class: "src" }, `${e.source_id} ／ ${e.locator || "—"} ／ ${fmtTime(e.at) || "日時不明"}　`),
    e.url ? h("a", { href: e.url, target: "_blank", rel: "noopener noreferrer" }, "元の資料を開く") : null,
    e.quote ? h("div", { class: "q" }, `「${e.quote}」`) : null)));
}

// ---------- タスク行（確定したタスク） ----------
function taskRow(t, { showProject = true, onChange } = {}) {
  const done = t.status === "done";
  const today = BOARD?.today;
  const overdue = t.due && today && t.due < today && !done && t.status !== "cancelled";
  const refresh = onChange || loadBoard;
  const evBox = h("div", { class: "evidence", hidden: true }, evidenceList(t.evidence));
  const editBox = h("div", { class: "edit-row", hidden: true });

  const cb = h("input", { type: "checkbox", checked: done, "aria-label": "完了にする",
    onchange: (e) => act(async () => { await api(`/api/pm/tasks/${t.id}`, { method: "PATCH", body: { status: e.target.checked ? "done" : "open" } }); await refresh(); }) });

  const meta = h("div", { class: "trow-meta" },
    showProject ? h("span", { class: "chip outline" }, t.project_name) : null,
    t.due ? h("span", { class: "chip " + (overdue ? "red" : "") }, `期限 ${fmtDate(t.due)}`) : h("span", { class: "chip" }, "期限未設定"),
    t.assignee ? h("span", { class: "chip" }, `担当 ${t.assignee}`) : h("span", { class: "chip" }, "担当未設定"),
    t.waiting_on ? h("span", { class: "chip orange" }, WAIT[t.waiting_on] + (t.waiting_detail ? `：${t.waiting_detail}` : "")) : null,
    t.status === "on_hold" ? h("span", { class: "chip" }, "保留") : null,
    h("span", { class: "chip outline" }, ORIGIN[t.origin] || t.origin),
    t.human_edited ? h("span", { class: "chip purple" }, "手動修正あり") : null,
    done ? h("span", { class: "chip green" }, `完了（${t.completion_basis === "human" ? "手動" : "記録に基づく"}）`) : null,
    h("button", { class: "link-btn", type: "button", onclick: () => { evBox.hidden = !evBox.hidden; } }, `根拠 ${t.evidence.length}件`));

  const sel = (name, opts, cur) => h("select", { name }, opts.map(([v, l]) => h("option", { value: v, selected: v === (cur ?? "") }, l)));
  const dueIn = h("input", { type: "date", name: "due", value: t.due || "" });
  const asgIn = h("input", { type: "text", name: "assignee", placeholder: "担当", value: t.assignee || "", size: 10 });
  const waitSel = sel("waiting_on", [["", "待ちなし"], ["client", "先方確認待ち"], ["material", "素材待ち"], ["permission", "権限待ち"], ["internal", "社内待ち"]], t.waiting_on);
  editBox.append(dueIn, asgIn, waitSel,
    h("button", { class: "btn small", type: "button", onclick: () => act(async () => {
      await api(`/api/pm/tasks/${t.id}`, { method: "PATCH", body: { due: dueIn.value || null, assignee: asgIn.value.trim() || null, waiting_on: waitSel.value || null } });
      await refresh();
    }) }, "保存"));

  const actions = h("div", { class: "trow-actions" },
    h("button", { class: "btn ghost small", type: "button", onclick: () => { editBox.hidden = !editBox.hidden; } }, "編集"),
    t.status === "on_hold"
      ? h("button", { class: "btn ghost small", type: "button", onclick: () => act(async () => { await api(`/api/pm/tasks/${t.id}`, { method: "PATCH", body: { status: "open" } }); await refresh(); }) }, "再開")
      : (!done ? h("button", { class: "btn ghost small", type: "button", onclick: () => act(async () => { await api(`/api/pm/tasks/${t.id}`, { method: "PATCH", body: { status: "on_hold" } }); await refresh(); }) }, "保留") : null));

  return h("div", { class: "trow" + (done ? " done" : "") },
    h("div", { class: "trow-main" }, cb, h("div", { class: "trow-body" }, h("div", { class: "trow-title" }, t.title), meta), actions),
    evBox, editBox);
}

function listOrEmpty(tasks, text, opts) {
  return tasks.length ? h("div", {}, tasks.map((t) => taskRow(t, opts))) : h("p", { class: "empty-mini" }, text);
}

// ---------- AI提案 ----------
function suggestionBox(s, refresh) {
  const evBox = h("div", { class: "evidence", hidden: true }, evidenceList(s.evidence));
  const call = (action) => act(async () => { await api(`/api/pm/suggestions/${s.id}/${action}`, { method: "POST" }); await refresh(); });
  return h("div", { class: "ai-box" },
    h("div", { class: "tag-ai" }, `AI提案（未合意）${s.project_name ? "　" + s.project_name : ""}`),
    h("p", {}, s.text, s.rationale ? h("span", { class: "why" }, `　理由：${s.rationale}`) : null),
    h("div", { class: "acts" },
      s.status === "proposed" ? [
        h("button", { class: "btn small", type: "button", onclick: () => call("adopt") }, "採用してタスクにする"),
        h("button", { class: "btn ghost small", type: "button", onclick: () => call("hold") }, "保留"),
        h("button", { class: "btn ghost small", type: "button", onclick: () => call("reject") }, "却下"),
      ] : [
        h("span", { class: "chip" }, { adopted: "採用済み", held: "保留中", rejected: "却下済み" }[s.status] || s.status),
        s.status !== "adopted" ? h("button", { class: "btn ghost small", type: "button", onclick: () => call("reopen") }, "提案に戻す") : null,
      ],
      h("button", { class: "link-btn", type: "button", onclick: () => { evBox.hidden = !evBox.hidden; } }, `根拠 ${s.evidence.length}件`)),
    evBox);
}

// ---------- 確認が必要な事項（まとめて回答） ----------
function reviewForm(items, refresh) {
  if (!items.length) return h("p", { class: "empty-mini" }, "確認が必要な事項はありません。");
  const answers = new Map();
  const rows = items.map((r) => {
    const body = h("div", { class: "rv" }, h("div", { class: "qtext" }, r.question));
    if (r.project_name) body.append(h("span", { class: "chip outline" }, r.project_name), " ");
    if (r.context?.url) body.append(h("a", { href: r.context.url, target: "_blank", rel: "noopener noreferrer" }, "元の資料を開く"));
    if (r.options?.length) {
      for (const o of r.options) {
        body.append(h("label", {}, h("input", { type: "radio", name: `rv-${r.id}`, value: o.value, onchange: () => answers.set(r.id, o.value) }), " ", o.label));
      }
    } else {
      body.append(h("input", { type: "text", placeholder: "回答を入力", oninput: (e) => { const v = e.target.value.trim(); v ? answers.set(r.id, v) : answers.delete(r.id); } }));
    }
    body.append(h("div", {}, h("button", { class: "link-btn", type: "button",
      onclick: () => act(async () => { await api(`/api/pm/review/${r.id}/dismiss`, { method: "POST" }); await refresh(); }) }, "確認しない（却下）")));
    return body;
  });
  const submit = h("button", { class: "btn", type: "button", onclick: () => act(async () => {
    if (!answers.size) throw new Error("回答が選ばれていません");
    const { results } = await api("/api/pm/review/answer", { method: "POST", body: { answers: [...answers].map(([id, answer]) => ({ id, answer })) } });
    const failed = results.filter((r) => r.error);
    await refresh();
    if (failed.length) throw new Error(failed.map((f) => f.error).join(" / "));
  }) }, "選んだ回答をまとめて送信");
  return h("div", {}, rows, h("div", { class: "rv-foot" }, submit, h("span", { class: "hint", style: "margin:0" }, `${items.length}件`)));
}

// ---------- 案件カード ----------
function projectCard(p) {
  const next = p.next_task
    ? h("div", { class: "next" }, h("b", {}, "次の一手（確定したタスク）"), p.next_task.title, p.next_task.due ? `　期限 ${fmtDate(p.next_task.due)}` : "")
    : p.next_suggestion
      ? h("div", { class: "next" }, h("b", {}, "次の一手（AI提案・未合意）"), p.next_suggestion.text)
      : p.waiting_count ? h("div", { class: "next" }, h("b", {}, "次の一手"), `待ち ${p.waiting_count}件`) : null;
  const ms = p.milestones || {};
  return h("button", { class: "proj" + (p.stalled ? " stalled" : ""), type: "button", onclick: () => openDetail(p.id) },
    h("h3", {}, p.name,
      h("span", { class: "chip " + (p.status === "active" ? "green" : "") }, PROJECT_STATUS[p.status] || p.status),
      p.phase ? h("span", { class: "chip purple" }, PHASE[p.phase] || p.phase) : null,
      p.stalled ? h("span", { class: "chip orange" }, "動きなし") : null),
    h("div", { class: "status" }, p.status_text || "状況はまだ整理されていません"),
    h("div", { class: "trow-meta" },
      h("span", {}, `未完了 ${p.open_count}件`),
      p.last_activity_at ? h("span", {}, `最終の動き ${ago(p.last_activity_at)}`) : h("span", {}, "動きの記録なし"),
      ms.produced ? h("span", { class: "chip" }, "制作完了") : null,
      ms.client_approved ? h("span", { class: "chip" }, "先方承認") : null,
      ms.published ? h("span", { class: "chip" }, "公開完了") : null),
    next,
    p.unknowns?.length ? h("div", { class: "unk" }, `未確認：${p.unknowns.join("、")}`) : null);
}

// ---------- 情報源の同期状態 ----------
function sourcesTable(sources) {
  if (!sources.length) return h("p", { class: "empty-mini" }, "情報源が登録されていません。設定から追加してください。");
  const rows = sources.map((s) => {
    const [label, color] = HEALTH[s.health] || [s.health, "muted"];
    return h("tr", {},
      h("td", {}, h("b", {}, s.name), h("div", { class: "hint", style: "margin:0" }, `${s.kind}・読み取り専用・${s.interval_min}分ごと`)),
      h("td", {}, h("span", { class: "chip " + color }, label)),
      h("td", {}, s.last_success_at ? `${fmtTime(s.last_success_at)}（${ago(s.last_success_at)}）` : "まだ取得できていません",
        s.health === "stale" ? h("div", { class: "src-err" }, "この情報源の内容は古い可能性があります（最後に取得できた内容を表示中）") : null,
        s.last_error ? h("div", { class: "src-err" }, s.last_error) : null,
        s.resync_requested_at ? h("div", { class: "hint", style: "margin:0" }, "再同期を要求済み（次回の取得で全体を確認）") : null),
      h("td", {}, h("button", { class: "btn ghost small", type: "button", onclick: () => act(async () => { await api(`/api/pm/sources/${s.id}/resync`, { method: "POST" }); await loadBoard(); }) }, "再同期を要求")));
  });
  return h("table", { class: "src-table" },
    h("thead", {}, h("tr", {}, h("th", {}, "情報源"), h("th", {}, "状態"), h("th", {}, "最終同期"), h("th", {}, ""))),
    h("tbody", {}, rows));
}

function renderSyncChip(sources) {
  const chip = $("syncChip");
  const enabled = sources.filter((s) => s.health !== "disabled");
  let text, color = "muted";
  if (!enabled.length) text = "情報源が未設定";
  else if (enabled.some((s) => s.health === "failed")) { text = "同期エラーあり"; color = "red"; }
  else if (enabled.some((s) => s.health === "stale")) { text = "情報が古い情報源あり"; color = "orange"; }
  else if (enabled.every((s) => s.health === "never")) text = "未同期";
  else {
    const last = enabled.map((s) => s.last_success_at).filter(Boolean).sort().pop();
    text = `最終同期 ${fmtTime(last)}`; color = "green";
  }
  chip.textContent = text;
  chip.className = "chip " + color;
}

// ---------- ボード ----------
async function loadBoard() {
  BOARD = await api("/api/pm/board");
  const b = BOARD;
  $("cDueToday").textContent = b.counts.due_today;
  $("cDueWeek").textContent = b.counts.due_week;
  $("cOverdue").textContent = b.counts.overdue;
  $("cReview").textContent = b.counts.review;
  renderSyncChip(b.sources);
  $("onboarding").hidden = b.projects.length > 0;

  const noSelf = !b.self_names.length;
  $("listMine").replaceChildren(
    ...(noSelf ? [h("p", { class: "hint" }, "設定で「自分の名前」を登録すると、担当が自分のタスクがここに集まります。")] : []),
    listOrEmpty(b.mine, "自分が担当のタスクはありません。"));

  const waitingAll = [["client", "先方確認待ち"], ["material", "素材待ち"], ["permission", "権限待ち"]];
  $("listWaiting").replaceChildren(...waitingAll.map(([k, label]) =>
    h("div", {}, h("div", { class: "group-title" }, `${label}（${b.waiting[k].length}）`), listOrEmpty(b.waiting[k], "なし"))));

  $("listOverdue").replaceChildren(listOrEmpty(b.overdue, "期限超過のタスクはありません。"));
  $("listDue").replaceChildren(
    h("div", { class: "group-title" }, `今日（${b.due_today.length}）`), listOrEmpty(b.due_today, "なし"),
    h("div", { class: "group-title" }, `今週（${b.due_week.length}）`), listOrEmpty(b.due_week, "なし"));

  $("listProjects").replaceChildren(...(b.projects.length ? b.projects.map(projectCard) : [h("p", { class: "empty-mini" }, "案件が登録されていません。")]));
  $("listStalled").replaceChildren(b.stalled.length
    ? h("div", {}, b.stalled.map((p) => h("div", { class: "trow" },
        h("div", { class: "trow-title" }, h("button", { class: "link-btn", type: "button", onclick: () => openDetail(p.id) }, p.name)),
        h("div", { class: "trow-meta" }, p.last_activity_at ? `最終の動き ${ago(p.last_activity_at)}` : "動きの記録なし", p.stalled_reason ? `　理由：${p.stalled_reason}` : ""))))
    : h("p", { class: "empty-mini" }, "止まっている案件はありません。"));

  $("listSuggest").replaceChildren(...(b.suggestions.length ? b.suggestions.map((s) => suggestionBox(s, loadBoard)) : [h("p", { class: "empty-mini" }, "現在の提案はありません。")]));
  $("listReview").replaceChildren(reviewForm(b.review, loadBoard));
  $("listSources").replaceChildren(sourcesTable(b.sources));
  if (!$("settingsBody").dataset.ready) await renderSettings();
}

// ---------- 案件詳細 ----------
let detailId = null;
async function openDetail(id, tab = "tasks") {
  detailId = id;
  const d = await api(`/api/pm/projects/${id}`);
  const dlg = $("detail");
  const reload = () => openDetail(id, currentTab);
  let currentTab = tab;

  const st = d.state || {};
  const ms = st.milestones || {};
  const head = h("div", { class: "dlg-head" },
    h("h2", {}, d.project.name, " ", h("span", { class: "chip " + (d.project.status === "active" ? "green" : "") }, PROJECT_STATUS[d.project.status] || d.project.status),
      st.phase ? [" ", h("span", { class: "chip purple" }, PHASE[st.phase] || st.phase)] : null),
    h("button", { class: "btn ghost small", type: "button", onclick: () => { dlg.close(); loadBoard(); } }, "閉じる"));

  const summary = h("div", { class: "dlg-body" },
    h("p", {}, st.status_text || "状況はまだ整理されていません"),
    h("div", { class: "milestones" },
      h("span", { class: "chip " + (ms.produced ? "green" : "") }, ms.produced ? "制作完了あり" : "制作完了：記録なし"),
      h("span", { class: "chip " + (ms.client_approved ? "green" : "") }, ms.client_approved ? "先方承認あり" : "先方承認：記録なし"),
      h("span", { class: "chip " + (ms.published ? "green" : "") }, ms.published ? "公開完了あり" : "公開完了：記録なし")),
    st.unknowns?.length ? h("p", { class: "hint" }, `未確認：${st.unknowns.join("、")}`) : null,
    d.review.length ? h("div", {}, h("div", { class: "group-title" }, "この案件の確認事項"), reviewForm(d.review.map((r) => ({ ...r, project_name: null })), reload)) : null);

  const panes = {
    tasks: () => {
      const wrap = h("div", {});
      const addIn = h("input", { type: "text", placeholder: "タスクを手動で追加", size: 28 });
      wrap.append(h("div", { class: "inline-form" }, addIn,
        h("button", { class: "btn small", type: "button", onclick: () => act(async () => {
          if (!addIn.value.trim()) return;
          await api("/api/pm/tasks", { method: "POST", body: { project_id: id, title: addIn.value.trim() } }); await reload();
        }) }, "追加")));
      const open = d.tasks.filter((t) => !["done", "cancelled"].includes(t.status));
      const closed = d.tasks.filter((t) => ["done", "cancelled"].includes(t.status));
      wrap.append(h("div", { class: "group-title" }, `確定したタスク（${open.length}）`), listOrEmpty(open, "未完了のタスクはありません。", { showProject: false, onChange: reload }));
      const sug = d.suggestions;
      wrap.append(h("div", { class: "group-title" }, `AI提案（${sug.filter((s) => s.status === "proposed").length}）`),
        ...(sug.length ? sug.map((s) => suggestionBox({ ...s, project_name: null }, reload)) : [h("p", { class: "empty-mini" }, "提案はありません。")]));
      if (closed.length) wrap.append(h("div", { class: "group-title" }, `完了・取消（${closed.length}）`), listOrEmpty(closed, "", { showProject: false, onChange: reload }));
      return wrap;
    },
    activity: () => {
      const projectOpts = (BOARD?.projects || []).map((p) => h("option", { value: p.id }, `${p.id} ${p.name}`));
      return d.activities.length ? h("div", {}, d.activities.map((a) => {
        const mv = h("select", { "aria-label": "紐づけを修正" }, h("option", { value: "" }, "紐づけを修正…"), ...projectOpts, h("option", { value: "__ignore__" }, "この案件に属さない（対象外）"));
        mv.addEventListener("change", () => mv.value && act(async () => { await api(`/api/pm/activities/${a.id}/assign`, { method: "POST", body: { project_id: mv.value } }); await reload(); }));
        return h("div", { class: "act" },
          h("div", { class: "when" }, `${fmtTime(a.occurred_at)}　${a.source_id}　${a.kind}　紐づけ：${{ link: "台帳の対応", hint: "AIの推定", manual: "手動" }[a.link_reason] || a.link_reason}`),
          h("div", {}, a.summary, " ", a.url ? h("a", { href: a.url, target: "_blank", rel: "noopener noreferrer" }, "開く") : null),
          a.snippet ? h("div", { class: "hint", style: "margin:2px 0" }, a.snippet) : null, mv);
      })) : h("p", { class: "empty-mini" }, "活動履歴はありません。");
    },
    decisions: () => d.decisions.length ? h("div", {}, d.decisions.map((x) => {
      const evBox = h("div", { class: "evidence", hidden: true }, evidenceList(x.evidence));
      return h("div", { class: "dec" }, h("div", {}, x.text), h("div", { class: "trow-meta" }, x.decided_at ? fmtTime(x.decided_at) : "",
        h("button", { class: "link-btn", type: "button", onclick: () => { evBox.hidden = !evBox.hidden; } }, `根拠 ${x.evidence.length}件`)), evBox);
    })) : h("p", { class: "empty-mini" }, "決定事項はまだありません。"),
    evidence: () => d.evidence_docs.length ? h("div", {}, d.evidence_docs.map((e) => h("div", { class: "act" },
      h("div", { class: "when" }, `${e.source_id}　${fmtTime(e.occurred_at) || "日時不明"}　参照 ${e.count}回`),
      h("div", {}, e.summary || e.ref, " ", e.url ? h("a", { href: e.url, target: "_blank", rel: "noopener noreferrer" }, "開く") : null),
      e.quote ? h("div", { class: "hint", style: "margin:2px 0" }, `「${e.quote}」`) : null))) : h("p", { class: "empty-mini" }, "根拠資料はまだありません。"),
    history: () => h("div", {},
      h("div", { class: "group-title" }, "情報源との対応（案件台帳）"),
      d.links.length ? h("ul", { class: "links", style: "padding-left:1em" }, d.links.map((l) => h("li", {}, `${l.source_kind} / ${l.ref_type}：${l.ref_value}${l.origin === "learned" ? "（修正から学習）" : ""}`))) : h("p", { class: "empty-mini" }, "未設定"),
      h("div", { class: "group-title" }, "更新履歴"),
      d.log.length ? d.log.map((l) => h("div", { class: "act" }, h("div", { class: "when" }, `${fmtTime(l.at)}　${l.actor === "human" ? "人" : "自動"}　${l.entity} ${l.action}`),
        l.after ? h("div", { class: "hint", style: "margin:0" }, JSON.stringify(l.after).slice(0, 200)) : null)) : h("p", { class: "empty-mini" }, "履歴はありません。")),
  };
  const labels = { tasks: "タスク", activity: "活動履歴", decisions: "決定事項", evidence: "根拠資料", history: "対応・履歴" };
  const body = h("div", { class: "dlg-body" });
  const tabs = h("div", { class: "tabs", role: "tablist", style: "padding:0 18px" });
  const show = (key) => {
    currentTab = key;
    for (const b of tabs.children) b.setAttribute("aria-selected", String(b.dataset.key === key));
    body.replaceChildren(panes[key]());
  };
  for (const [k, l] of Object.entries(labels)) tabs.append(h("button", { role: "tab", "data-key": k, "aria-selected": "false", onclick: () => show(k) }, l));
  dlg.replaceChildren(head, summary, tabs, body);
  show(tab);
  if (!dlg.open) dlg.showModal();
}

// ---------- 設定 ----------
async function renderSettings() {
  const root = $("settingsBody");
  const [{ projects }, { sources }, { settings }] = await Promise.all([api("/api/pm/projects"), api("/api/pm/sources"), api("/api/pm/settings")]);
  root.dataset.ready = "1";
  const reload = async () => { delete root.dataset.ready; await renderSettings(); await loadBoard(); };

  // 案件台帳
  const pName = h("input", { type: "text", placeholder: "案件名", size: 20 });
  const pClient = h("input", { type: "text", placeholder: "クライアント", size: 14 });
  const ledger = h("div", {},
    h("h3", {}, "案件台帳"),
    h("p", { class: "hint" }, "稼働状態は人が決めます。フォルダがあるだけでは稼働中として扱いません。"),
    projects.map((p) => {
      const st = h("select", {}, Object.entries(PROJECT_STATUS).map(([v, l]) => h("option", { value: v, selected: v === p.status }, l)));
      st.addEventListener("change", () => act(async () => { await api(`/api/pm/projects/${p.id}`, { method: "PATCH", body: { status: st.value } }); await reload(); }));
      const kind = h("select", {}, ["drive", "gmail", "docs", "sheets", "minutes", "task_tool", "chat"].map((k) => h("option", { value: k }, k)));
      const rtype = h("select", {}, ["drive_folder", "gmail_label", "gmail_thread", "keyword", "url", "chat_channel"].map((k) => h("option", { value: k }, k)));
      const rval = h("input", { type: "text", placeholder: "フォルダID／ラベル名／キーワード など", size: 28 });
      return h("div", { class: "plist" },
        h("div", { class: "inline-form" }, h("b", {}, `${p.id}　${p.name}`), p.client ? h("span", { class: "chip outline" }, p.client) : null, st),
        h("ul", { class: "links" }, p.links.map((l) => h("li", {}, `${l.source_kind} / ${l.ref_type}：${l.ref_value}${l.origin === "learned" ? "（学習）" : ""}`,
          h("button", { class: "link-btn", type: "button", onclick: () => act(async () => { await api(`/api/pm/links/${l.id}`, { method: "DELETE" }); await reload(); }) }, "削除")))),
        h("div", { class: "inline-form" }, kind, rtype, rval,
          h("button", { class: "btn ghost small", type: "button", onclick: () => act(async () => {
            if (!rval.value.trim()) return;
            await api(`/api/pm/projects/${p.id}/links`, { method: "POST", body: { source_kind: kind.value, ref_type: rtype.value, ref_value: rval.value.trim() } }); await reload();
          }) }, "対応を追加")));
    }),
    h("div", { class: "inline-form" }, pName, pClient,
      h("button", { class: "btn small", type: "button", onclick: () => act(async () => {
        if (!pName.value.trim()) return;
        await api("/api/pm/projects", { method: "POST", body: { name: pName.value.trim(), client: pClient.value.trim(), status: "active" } }); await reload();
      }) }, "案件を追加")));

  // 情報源
  const sId = h("input", { type: "text", placeholder: "ID（例: gmail-main）", size: 16 });
  const sKind = h("select", {}, ["gmail", "drive", "docs", "sheets", "minutes", "task_tool", "chat"].map((k) => h("option", { value: k }, k)));
  const sName = h("input", { type: "text", placeholder: "表示名", size: 16 });
  const srcSection = h("div", {},
    h("h3", {}, "情報源（読み取り専用）"),
    sources.map((s) => {
      const interval = h("select", {}, [15, 30, 60, 180, 360, 1440].map((m) => h("option", { value: m, selected: m === s.interval_min }, m >= 60 ? `${m / 60}時間ごと` : `${m}分ごと`)));
      const cfg = h("textarea", { rows: 3 }, JSON.stringify(s.config, null, 2));
      return h("div", { class: "plist" },
        h("div", { class: "inline-form" }, h("b", {}, s.name), h("span", { class: "chip outline" }, s.kind), interval,
          h("label", {}, h("input", { type: "checkbox", checked: !!s.enabled, onchange: (e) => act(async () => { await api(`/api/pm/sources/${s.id}`, { method: "PATCH", body: { enabled: e.target.checked } }); await reload(); }) }), " 有効")),
        h("div", { class: "field" }, h("label", {}, "取得範囲（AI処理側が参照。許可するフォルダ・ラベルなど）"), cfg),
        h("button", { class: "btn small", type: "button", onclick: () => act(async () => {
          let config; try { config = JSON.parse(cfg.value || "{}"); } catch { throw new Error("取得範囲はJSONで入力してください"); }
          await api(`/api/pm/sources/${s.id}`, { method: "PATCH", body: { interval_min: Number(interval.value), config } }); await reload();
        }) }, "保存"));
    }),
    h("div", { class: "inline-form" }, sId, sKind, sName,
      h("button", { class: "btn small", type: "button", onclick: () => act(async () => {
        if (!sId.value.trim() || !sName.value.trim()) return;
        await api("/api/pm/sources", { method: "POST", body: { id: sId.value.trim(), kind: sKind.value, name: sName.value.trim() } }); await reload();
      }) }, "情報源を追加")));

  // 収集・保存・AI送信
  const csv = (a) => (a || []).join("、");
  const f = {
    self: h("input", { type: "text", value: csv(settings.self_names), placeholder: "担当者名（、区切り。例: 松井、Matsui）" }),
    stale: h("input", { type: "number", min: 1, value: settings.stale_days }),
    retention: h("input", { type: "number", min: 1, value: settings.retention_days }),
    snippet: h("input", { type: "number", min: 20, max: 1000, value: settings.snippet_max_chars }),
    folders: h("textarea", { rows: 2 }, csv(settings.denylist.folder_names)),
    patterns: h("textarea", { rows: 2 }, csv(settings.denylist.file_name_patterns)),
    bodyMax: h("input", { type: "number", min: 0, value: settings.ai_scope.body_max_chars }),
    include: h("textarea", { rows: 2 }, csv(settings.ai_scope.include)),
    exclude: h("textarea", { rows: 2 }, csv(settings.ai_scope.exclude)),
  };
  const split = (s) => s.split(/[、,\n]/).map((x) => x.trim()).filter(Boolean);
  const field = (label, el) => h("div", { class: "field" }, h("label", {}, label), el);
  const policy = h("div", {},
    h("h3", {}, "収集・保存・AIへ送る範囲"),
    field("自分の名前（「自分が対応すること」の判定に使用）", f.self),
    field("動きが止まっていると判断する日数", f.stale),
    field("活動記録・根拠の引用を保存する日数（過ぎたものは自動削除）", f.retention),
    field("根拠として保存する引用の最大文字数", f.snippet),
    field("収集しないフォルダ名", f.folders),
    field("収集しないファイル名のパターン", f.patterns),
    field("AIへ送る本文の最大文字数", f.bodyMax),
    field("AIへ送る項目", f.include),
    field("AIへ送らない情報", f.exclude),
    h("p", { class: "hint" }, "取得とAI処理は別の仕組み（同期ジョブ）が行います。ここで設定した範囲は同期ジョブが取得時に参照します。"),
    h("button", { class: "btn", type: "button", onclick: () => act(async () => {
      await api("/api/pm/settings", { method: "PUT", body: {
        self_names: split(f.self.value), stale_days: Number(f.stale.value), retention_days: Number(f.retention.value), snippet_max_chars: Number(f.snippet.value),
        denylist: { folder_names: split(f.folders.value), file_name_patterns: split(f.patterns.value) },
        ai_scope: { include: split(f.include.value), body_max_chars: Number(f.bodyMax.value), exclude: split(f.exclude.value) },
      } });
      await reload();
    }) }, "設定を保存"));

  root.replaceChildren(ledger, srcSection, policy);
}

// ---------- 起動 ----------
for (const btn of document.querySelectorAll(".side-btn")) {
  btn.addEventListener("click", () => {
    const target = document.getElementById(btn.dataset.target);
    if (btn.dataset.target === "sec-settings") target?.querySelector("details")?.setAttribute("open", "");
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
    for (const b of document.querySelectorAll(".side-btn")) b.classList.toggle("active", b === btn);
  });
}
for (const el of document.querySelectorAll("[data-goto]")) {
  el.addEventListener("click", () => {
    const t = document.getElementById(el.dataset.goto);
    if (el.dataset.goto === "sec-settings") t?.querySelector("details")?.setAttribute("open", "");
    t?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}
$("reload").addEventListener("click", () => act(loadBoard));
document.addEventListener("visibilitychange", () => { if (!document.hidden && !$("detail").open) act(loadBoard); });
setInterval(() => { if (!document.hidden && !$("detail").open) act(loadBoard); }, 60000);
act(loadBoard);

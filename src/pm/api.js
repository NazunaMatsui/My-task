import {
  ACTIVE_STATUSES, PHASES, WAIT_ON, applyBatch, applyItemToProject, fingerprint,
  getSettings, log, nowIso, DEFAULT_SETTINGS,
} from "./engine.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const bad = (msg, status = 400) => json({ error: msg }, status);
const jparse = (s, fb) => { try { return s ? JSON.parse(s) : fb; } catch { return fb; } };
const clip = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const one = (db, sql, ...b) => db.prepare(sql).bind(...b).first();
const all = async (db, sql, ...b) => (await db.prepare(sql).bind(...b).all()).results;
const run = (db, sql, ...b) => db.prepare(sql).bind(...b).run();

const jstDay = (ms) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date(ms));

function shiftDate(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
function weekEnd(ymd) {
  // 今週 = 月曜始まり、日曜まで
  const [y, m, d] = ymd.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=日
  return shiftDate(ymd, dow === 0 ? 0 : 7 - dow);
}

// ---------- 整形 ----------

const taskRow = (t, names) => ({
  id: t.id, project_id: t.project_id, project_name: names?.get(t.project_id) || t.project_id, title: t.title,
  status: t.status, assignee: t.assignee, due: t.due, waiting_on: t.waiting_on, waiting_detail: t.waiting_detail,
  origin: t.origin, completion_basis: t.completion_basis, human_edited: !!t.human_edited,
  evidence: jparse(t.evidence, []), updated_at: t.updated_at,
});

function sourceHealth(s, now) {
  const interval = Math.max(s.interval_min || 60, 5);
  let health = "ok";
  if (!s.enabled) health = "disabled";
  else if (!s.last_success_at && !s.last_attempt_at) health = "never";
  else if (s.last_status === "failed" && (!s.last_success_at || s.last_attempt_at > s.last_success_at)) health = "failed";
  else if (!s.last_success_at || now - Date.parse(s.last_success_at) > Math.max(2 * interval, 60) * 60000) health = "stale";
  else if (s.last_status === "partial") health = "partial";
  return { ...s, config: jparse(s.config, {}), health };
}

// ---------- ボード ----------

async function board(db) {
  const now = Date.now();
  const today = jstDay(now);
  const wkEnd = weekEnd(today);
  const settings = await getSettings(db);
  const self = settings.self_names.map((n) => String(n).toLowerCase());

  const projects = await all(db, "SELECT * FROM pm_projects ORDER BY id");
  const names = new Map(projects.map((p) => [p.id, p.name]));
  const states = new Map((await all(db, "SELECT * FROM pm_project_state")).map((s) => [s.project_id, s]));
  const tasks = (await all(db, `SELECT * FROM pm_tasks WHERE status IN ('open','in_progress','waiting','on_hold') ORDER BY (due IS NULL), due, created_at`)).map((t) => taskRow(t, names));
  const active = tasks.filter((t) => ACTIVE_STATUSES.includes(t.status));

  const dueToday = active.filter((t) => t.due === today);
  const dueWeek = active.filter((t) => t.due && t.due > today && t.due <= wkEnd);
  const overdue = active.filter((t) => t.due && t.due < today);
  const mine = active.filter((t) => t.assignee && self.includes(t.assignee.toLowerCase()));
  const waiting = Object.fromEntries(["client", "material", "permission"].map((k) => [k, active.filter((t) => t.status === "waiting" && t.waiting_on === k)]));

  const staleMs = settings.stale_days * 86400000;
  const proj = projects.map((p) => {
    const st = states.get(p.id);
    const mineTasks = active.filter((t) => t.project_id === p.id);
    const nextTask = mineTasks.filter((t) => t.status !== "waiting")[0] || null;
    return { p, st, mineTasks, nextTask };
  });
  const suggestions = (await all(db, "SELECT * FROM pm_suggestions WHERE status='proposed' ORDER BY created_at DESC LIMIT 50"))
    .map((s) => ({ ...s, evidence: jparse(s.evidence, []), project_name: names.get(s.project_id) }));
  const topSuggestion = new Map();
  for (const s of suggestions) if (!topSuggestion.has(s.project_id)) topSuggestion.set(s.project_id, s);

  const projectCards = proj.map(({ p, st, mineTasks, nextTask }) => {
    const last = st?.last_activity_at || null;
    const open = mineTasks.length;
    const stalled = p.status === "active" && (open > 0 || (st?.phase && st.phase !== "done")) &&
      (!last || now - Date.parse(last) > staleMs);
    return {
      id: p.id, name: p.name, status: p.status, client: p.client,
      phase: st?.phase || null, status_text: st?.status_text || null, stalled_reason: st?.stalled_reason || null,
      unknowns: jparse(st?.unknowns, []), milestones: jparse(st?.milestones, {}),
      last_activity_at: last, open_count: open, stalled,
      next_task: nextTask ? { id: nextTask.id, title: nextTask.title, due: nextTask.due, assignee: nextTask.assignee } : null,
      waiting_count: mineTasks.filter((t) => t.status === "waiting").length,
      next_suggestion: topSuggestion.get(p.id) ? { id: topSuggestion.get(p.id).id, text: topSuggestion.get(p.id).text } : null,
    };
  });

  const reviews = (await all(db, "SELECT * FROM pm_review_items WHERE status='open' ORDER BY created_at")).map((r) => ({
    ...r, options: jparse(r.options, []), context: jparse(r.context, {}), project_name: names.get(r.project_id) || null,
  }));
  const sources = (await all(db, "SELECT * FROM pm_sources ORDER BY id")).map((s) => sourceHealth(s, now));
  const unassigned = await one(db, "SELECT COUNT(*) AS n FROM pm_activities WHERE project_id IS NULL AND excluded=0");

  return {
    now: new Date(now).toISOString(), today, week_end: wkEnd,
    self_names: settings.self_names,
    counts: { due_today: dueToday.length, due_week: dueWeek.length, overdue: overdue.length, mine: mine.length, review: reviews.length, suggestions: suggestions.length, unassigned: unassigned.n },
    due_today: dueToday, due_week: dueWeek, overdue, mine, waiting,
    stalled: projectCards.filter((p) => p.stalled),
    projects: projectCards,
    suggestions, review: reviews, sources,
  };
}

async function projectDetail(db, id) {
  const p = await one(db, "SELECT * FROM pm_projects WHERE id=?", id);
  if (!p) return null;
  const names = new Map([[p.id, p.name]]);
  const st = await one(db, "SELECT * FROM pm_project_state WHERE project_id=?", id);
  const tasks = (await all(db, "SELECT * FROM pm_tasks WHERE project_id=? ORDER BY (status IN ('done','cancelled')), (due IS NULL), due, created_at", id)).map((t) => taskRow(t, names));
  const decisions = (await all(db, "SELECT * FROM pm_decisions WHERE project_id=? ORDER BY COALESCE(decided_at, created_at) DESC", id)).map((d) => ({ ...d, evidence: jparse(d.evidence, []) }));
  const suggestions = (await all(db, "SELECT * FROM pm_suggestions WHERE project_id=? ORDER BY (status!='proposed'), created_at DESC", id)).map((s) => ({ ...s, evidence: jparse(s.evidence, []) }));
  const activities = (await all(db, "SELECT id, source_id, ref, occurred_at, kind, summary, snippet, url, link_reason FROM pm_activities WHERE project_id=? AND excluded=0 ORDER BY occurred_at DESC LIMIT 60", id));
  const links = await all(db, "SELECT * FROM pm_project_links WHERE project_id=?", id);
  const reviews = (await all(db, "SELECT * FROM pm_review_items WHERE project_id=? AND status='open'", id)).map((r) => ({ ...r, options: jparse(r.options, []), context: jparse(r.context, {}) }));
  const log = await all(db, "SELECT at, actor, entity, entity_id, action, before, after, reason FROM pm_change_log WHERE (entity='project' AND entity_id=?) OR (entity='task' AND entity_id IN (SELECT id FROM pm_tasks WHERE project_id=?)) ORDER BY id DESC LIMIT 40", id, id);

  // 根拠資料: 参照されている出典を重複なしで集める
  const refs = new Map();
  const collect = (list) => { for (const e of list) { const k = `${e.source_id}|${e.ref}`; if (!refs.has(k)) refs.set(k, { ...e, count: 0 }); refs.get(k).count++; } };
  tasks.forEach((t) => collect(t.evidence));
  decisions.forEach((d) => collect(d.evidence));
  collect(jparse(st?.evidence, []));
  const evidenceDocs = [];
  for (const e of refs.values()) {
    const a = await one(db, "SELECT summary, url, occurred_at FROM pm_activities WHERE source_id=? AND ref=? ORDER BY id DESC LIMIT 1", e.source_id, e.ref);
    evidenceDocs.push({ ...e, summary: a?.summary || null, url: a?.url || e.url || null, occurred_at: a?.occurred_at || e.at || null });
  }
  return {
    project: p,
    state: st ? { ...st, unknowns: jparse(st.unknowns, []), milestones: jparse(st.milestones, {}), evidence: jparse(st.evidence, []), human_fields: jparse(st.human_fields, []) } : null,
    tasks, decisions, suggestions, activities, links, review: reviews,
    evidence_docs: evidenceDocs, log: log.map((l) => ({ ...l, before: jparse(l.before, null), after: jparse(l.after, null) })),
  };
}

// ---------- 人による操作（修正は保持され、自動更新で上書きされない） ----------

const TASK_STATUS = ["open", "in_progress", "waiting", "done", "cancelled", "on_hold"];

async function humanPatchTask(db, id, body) {
  const t = await one(db, "SELECT * FROM pm_tasks WHERE id=?", id);
  if (!t) return { error: "タスクが見つかりません", status: 404 };
  const changes = {};
  if (typeof body.title === "string") { const v = clip(body.title, 200); if (!v) return { error: "title が空です" }; changes.title = v; changes.fingerprint = fingerprint(v); }
  if (body.status !== undefined) { if (!TASK_STATUS.includes(body.status)) return { error: "status が不正です" }; changes.status = body.status; }
  if (body.due !== undefined) { if (body.due !== null && !DATE_RE.test(body.due)) return { error: "due が不正です" }; changes.due = body.due; }
  if (body.assignee !== undefined) changes.assignee = body.assignee ? clip(body.assignee, 60) : null;
  if (body.waiting_on !== undefined) { if (body.waiting_on !== null && !WAIT_ON.includes(body.waiting_on)) return { error: "waiting_on が不正です" }; changes.waiting_on = body.waiting_on; }
  if (body.waiting_detail !== undefined) changes.waiting_detail = body.waiting_detail ? clip(body.waiting_detail, 200) : null;
  if (body.project_id !== undefined) {
    if (!(await one(db, "SELECT 1 FROM pm_projects WHERE id=?", body.project_id))) return { error: "project_id が不正です" };
    changes.project_id = body.project_id;
  }
  const keys = Object.keys(changes).filter((k) => k !== "fingerprint" && changes[k] !== t[k]);
  if (!keys.length) return { task: t };
  if (changes.status === "done") { changes.completion_basis = "human"; changes.done_at = nowIso(); }
  else if (changes.status && t.status === "done") { changes.completion_basis = null; changes.done_at = null; }
  if (changes.waiting_on && !changes.status && t.status === "open") changes.status = "waiting";

  const human = new Set(jparse(t.human_fields, []));
  for (const k of keys) human.add(k);
  const at = nowIso();
  const cols = Object.keys(changes);
  await run(db, `UPDATE pm_tasks SET ${cols.map((c) => `${c}=?`).join(", ")}, human_edited=1, human_fields=?, updated_at=? WHERE id=?`,
    ...cols.map((c) => changes[c]), JSON.stringify([...human]), at, id);
  await log(db, "human", "task", id, "edited", Object.fromEntries(keys.map((k) => [k, t[k]])), Object.fromEntries(keys.map((k) => [k, changes[k]])), null);
  return { task: await one(db, "SELECT * FROM pm_tasks WHERE id=?", id) };
}

async function lockField(db, taskId, field) {
  const t = await one(db, "SELECT human_fields FROM pm_tasks WHERE id=?", taskId);
  if (!t) return;
  const human = new Set(jparse(t.human_fields, []));
  human.add(field);
  await run(db, "UPDATE pm_tasks SET human_fields=?, human_edited=1 WHERE id=?", JSON.stringify([...human]), taskId);
}

async function suggestionAction(db, id, action) {
  const s = await one(db, "SELECT * FROM pm_suggestions WHERE id=?", id);
  if (!s) return { error: "提案が見つかりません", status: 404 };
  const at = nowIso();
  if (action === "adopt") {
    if (s.status === "adopted") return { suggestion: s };
    const taskId = "T-" + crypto.randomUUID().slice(0, 8);
    await run(db, `INSERT INTO pm_tasks (id, project_id, title, fingerprint, status, origin, evidence, human_edited, created_at, updated_at)
                   VALUES (?,?,?,?, 'open', 'adopted_suggestion', ?, 1, ?, ?)`,
      taskId, s.project_id, s.text.slice(0, 200), fingerprint(s.text), s.evidence, at, at);
    await run(db, "UPDATE pm_suggestions SET status='adopted', adopted_task_id=?, resolved_at=? WHERE id=?", taskId, at, id);
    await log(db, "human", "suggestion", id, "adopted", { status: s.status }, { task_id: taskId }, null);
    return { task_id: taskId };
  }
  const status = { hold: "held", reject: "rejected", reopen: "proposed" }[action];
  if (!status) return { error: "action が不正です" };
  await run(db, "UPDATE pm_suggestions SET status=?, resolved_at=? WHERE id=?", status, status === "proposed" ? null : at, id);
  await log(db, "human", "suggestion", id, action, { status: s.status }, { status }, null);
  return { ok: true };
}

// 案件の紐づけを人が直す。以降の同じスレッド・フォルダにも反映する
const LEARNABLE = ["gmail_thread", "drive_folder", "drive_file", "doc", "sheet", "chat_channel"];

async function assignActivityRef(db, sourceId, ref, projectId) {
  const rows = await all(db, "SELECT id, group_keys, project_id FROM pm_activities WHERE source_id=? AND ref=?", sourceId, ref);
  if (!rows.length) return { error: "活動記録が見つかりません", status: 404 };
  const src = await one(db, "SELECT kind FROM pm_sources WHERE id=?", sourceId);
  const at = nowIso();
  for (const r of rows) {
    await run(db, "UPDATE pm_activities SET project_id=?, link_reason='manual', excluded=0 WHERE id=?", projectId, r.id);
    for (const g of jparse(r.group_keys, [])) {
      if (projectId && LEARNABLE.includes(g.type)) {
        await run(db, "INSERT OR IGNORE INTO pm_project_links (project_id, source_kind, ref_type, ref_value, label, origin) VALUES (?,?,?,?,?, 'learned')",
          projectId, src?.kind || "unknown", g.type, g.value, "紐づけ修正から学習");
      }
    }
    await log(db, "human", "activity", r.id, "assigned", { project_id: r.project_id }, { project_id: projectId }, null);
  }
  if (projectId) {
    const last = (await one(db, "SELECT MAX(occurred_at) AS m FROM pm_activities WHERE project_id=? AND excluded=0", projectId)).m;
    await run(db, `INSERT INTO pm_project_state (project_id, updated_at, last_activity_at) VALUES (?,?,?)
                   ON CONFLICT(project_id) DO UPDATE SET last_activity_at=excluded.last_activity_at`, projectId, at, last);
    // 案件が決まらず保留していた抽出内容を反映
    const held = await all(db, "SELECT * FROM pm_held_items WHERE source_id=? AND activity_ref=?", sourceId, ref);
    const ctx = { db, settings: await getSettings(db), src: { id: sourceId }, stats: { tasks_created: 0, tasks_updated: 0, completed: 0, decisions: 0, suggestions: 0, reviews: 0, held: 0, rejected: [], errors: [] } };
    for (const h of held) {
      try { await applyItemToProject(ctx, jparse(h.item, {}), projectId); } catch (e) { ctx.stats.errors.push(e.message); }
      await run(db, "DELETE FROM pm_held_items WHERE id=?", h.id);
    }
  }
  return { ok: true };
}

async function excludeActivityRef(db, sourceId, ref) {
  await run(db, "UPDATE pm_activities SET excluded=1, project_id=NULL WHERE source_id=? AND ref=?", sourceId, ref);
  await run(db, "DELETE FROM pm_held_items WHERE source_id=? AND activity_ref=?", sourceId, ref);
  await log(db, "human", "activity", `${sourceId}:${ref}`, "excluded", null, null, "対象外");
}

async function answerReview(db, id, answer) {
  const r = await one(db, "SELECT * FROM pm_review_items WHERE id=?", id);
  if (!r) return { error: "確認事項が見つかりません", status: 404 };
  if (r.status !== "open") return { error: "回答済みです", status: 409 };
  const ctx = jparse(r.context, {});
  const at = nowIso();
  answer = clip(String(answer ?? ""), 500);
  if (!answer) return { error: "回答が空です" };

  if (r.kind === "conflict" && ctx.task_id) {
    if (answer === "incoming") {
      if (ctx.field === "status") {
        await humanPatchTask(db, ctx.task_id, { status: ctx.incoming });
      } else {
        await humanPatchTask(db, ctx.task_id, { [ctx.field]: ctx.incoming });
      }
    } else if (answer === "existing") {
      await lockField(db, ctx.task_id, ctx.field);
    } else return { error: "回答が不正です" };
  } else if (r.kind === "completion_unclear") {
    if (answer === "done") {
      if (ctx.task_id) await humanPatchTask(db, ctx.task_id, { status: "done" });
      else if (r.project_id && ctx.title) {
        const taskId = "T-" + crypto.randomUUID().slice(0, 8);
        await run(db, `INSERT INTO pm_tasks (id, project_id, title, fingerprint, status, completion_basis, origin, evidence, human_edited, created_at, updated_at, done_at)
                       VALUES (?,?,?,?, 'done', 'human', 'ai_extracted', ?, 1, ?, ?, ?)`,
          taskId, r.project_id, ctx.title, fingerprint(ctx.title), JSON.stringify(ctx.evidence || []), at, at, at);
      }
    } else if (answer !== "not_done") return { error: "回答が不正です" };
  } else if (r.kind === "unassigned_activity" || r.kind === "multi_project") {
    if (answer === "__ignore__") await excludeActivityRef(db, ctx.source_id, ctx.ref);
    else {
      if (!(await one(db, "SELECT 1 FROM pm_projects WHERE id=?", answer))) return { error: "案件が不正です" };
      const res = await assignActivityRef(db, ctx.source_id, ctx.ref, answer);
      if (res.error) return res;
    }
  } else if (r.kind === "state_conflict") {
    const st = await one(db, "SELECT human_fields FROM pm_project_state WHERE project_id=?", ctx.project_id);
    const human = new Set(jparse(st?.human_fields, []));
    human.add(ctx.field);
    if (answer === "incoming") {
      await run(db, `UPDATE pm_project_state SET ${ctx.field}=?, human_fields=?, updated_at=? WHERE project_id=?`, ctx.incoming, JSON.stringify([...human]), at, ctx.project_id);
      await log(db, "human", "project", ctx.project_id, "state_updated", { [ctx.field]: ctx.existing }, { [ctx.field]: ctx.incoming }, "確認事項への回答");
    } else if (answer === "existing") {
      await run(db, "UPDATE pm_project_state SET human_fields=?, updated_at=? WHERE project_id=?", JSON.stringify([...human]), at, ctx.project_id);
    } else return { error: "回答が不正です" };
  } else if (r.kind === "question") {
    if (r.project_id) {
      const text = `${r.question} → ${answer}`.slice(0, 400);
      await run(db, "INSERT OR IGNORE INTO pm_decisions (project_id, text, fingerprint, decided_at, evidence, created_at) VALUES (?,?,?,?,?,?)",
        r.project_id, text, fingerprint(text), at, JSON.stringify([{ source_id: "human", ref: `review-${id}`, locator: "確認事項への回答", at, quote: answer.slice(0, 200), url: "" }]), at);
    }
  }
  await run(db, "UPDATE pm_review_items SET status='answered', answer=?, resolved_at=? WHERE id=?", answer, at, id);
  await log(db, "human", "review", id, "answered", null, { answer }, null);
  return { ok: true };
}

// ---------- 設定 ----------

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);
async function putSettings(db, body) {
  for (const [k, v] of Object.entries(body || {})) {
    if (!SETTING_KEYS.includes(k)) return { error: `未対応の設定: ${k}` };
    if (k === "self_names" && !(Array.isArray(v) && v.every((x) => typeof x === "string"))) return { error: "self_names は文字列の配列です" };
    if (["stale_days", "retention_days", "snippet_max_chars"].includes(k) && !(Number.isInteger(v) && v > 0 && v <= 3650)) return { error: `${k} は正の整数です` };
    await run(db, "INSERT INTO pm_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", k, JSON.stringify(v));
  }
  return { settings: await getSettings(db) };
}

// ---------- 定期処理（保存期間を過ぎた記録の削除） ----------

export async function purgeExpired(db) {
  const { retention_days } = await getSettings(db);
  const cutoff = new Date(Date.now() - retention_days * 86400000).toISOString();
  const a = await run(db, "DELETE FROM pm_activities WHERE occurred_at < ?", cutoff);
  await run(db, "DELETE FROM pm_held_items WHERE created_at < ?", cutoff);
  // 根拠の引用文も保存期間を過ぎたら消す（出典の参照先は残す）
  for (const table of ["pm_tasks", "pm_decisions", "pm_suggestions", "pm_project_state"]) {
    const rows = await all(db, `SELECT rowid AS rid, evidence FROM ${table} WHERE evidence LIKE '%"quote":"_%'`);
    for (const r of rows) {
      const ev = jparse(r.evidence, []);
      let changed = false;
      for (const e of ev) if (e.quote && e.at && e.at < cutoff) { e.quote = ""; changed = true; }
      if (changed) await run(db, `UPDATE ${table} SET evidence=? WHERE rowid=?`, JSON.stringify(ev), r.rid);
    }
  }
  return a.meta.changes;
}

export async function applyPending(db) {
  const rows = await all(db, "SELECT * FROM pm_batches WHERE status='pending' ORDER BY id LIMIT 20");
  const out = [];
  for (const b of rows) {
    let res;
    try { res = await applyBatch(db, jparse(b.payload, null)); } catch (e) { res = { ok: false, errors: [e.message] }; }
    await run(db, "UPDATE pm_batches SET status=?, result=?, applied_at=? WHERE id=?", res.ok ? "applied" : "failed", JSON.stringify(res), nowIso(), b.id);
    out.push({ id: b.id, ok: res.ok });
  }
  return out;
}

// ---------- ルーティング ----------

export async function handlePm(request, env, url, auth) {
  const db = env.DB;
  const { pathname } = url;
  const method = request.method;
  const path = pathname.replace(/^\/api\/pm/, "") || "/";
  const body = async () => { try { return await request.json(); } catch { return null; } };

  // 取り込み口: AI処理側（トークン認証）だけが書き込める
  if (path === "/ingest" && method === "POST") {
    if (auth !== "ingest") return bad("取り込みトークンが必要です", 401);
    const b = await body();
    if (!b) return bad("不正なJSONです");
    const res = await applyBatch(db, b);
    await run(db, "INSERT INTO pm_batches (received_at, status, payload, result, applied_at) VALUES (?,?,?,?,?)",
      nowIso(), res.ok ? "applied" : "failed", JSON.stringify(b).slice(0, 900000), JSON.stringify(res), nowIso());
    return json(res, res.ok ? 200 : 400);
  }
  if (path === "/sync-config" && method === "GET") {
    if (auth !== "ingest" && auth !== "editor" && auth !== "viewer") return bad("認証が必要です", 401);
    const settings = await getSettings(db);
    return json({
      projects: await all(db, "SELECT id, name, status, client FROM pm_projects ORDER BY id"),
      links: await all(db, "SELECT project_id, source_kind, ref_type, ref_value, label FROM pm_project_links"),
      sources: (await all(db, "SELECT * FROM pm_sources WHERE enabled=1")).map((s) => ({ ...s, config: jparse(s.config, {}) })),
      settings: { snippet_max_chars: settings.snippet_max_chars, retention_days: settings.retention_days, ai_scope: settings.ai_scope, denylist: settings.denylist },
    });
  }

  if (auth === "ingest") return bad("このトークンでは操作できません", 403);
  const write = ["POST", "PATCH", "PUT", "DELETE"].includes(method);
  if (write && auth === "viewer") return bad("閲覧専用のため変更できません", 403);

  if (path === "/board" && method === "GET") return json(await board(db));
  if (path === "/settings" && method === "GET") return json({ settings: await getSettings(db) });
  if (path === "/settings" && method === "PUT") {
    const r = await putSettings(db, await body());
    return r.error ? bad(r.error) : json(r);
  }

  // 案件台帳
  if (path === "/projects" && method === "GET") {
    const rows = await all(db, "SELECT * FROM pm_projects ORDER BY id");
    const links = await all(db, "SELECT * FROM pm_project_links ORDER BY project_id, id");
    return json({ projects: rows.map((p) => ({ ...p, links: links.filter((l) => l.project_id === p.id) })) });
  }
  if (path === "/projects" && method === "POST") {
    const b = await body();
    const name = clip(b?.name, 100);
    if (!name) return bad("name が必要です");
    const id = clip(b.id, 40) || `P-${String((await one(db, "SELECT COUNT(*) AS n FROM pm_projects")).n + 1).padStart(3, "0")}`;
    const status = ["active", "paused", "done", "unknown"].includes(b.status) ? b.status : "unknown";
    try {
      await run(db, "INSERT INTO pm_projects (id, name, status, client, note) VALUES (?,?,?,?,?)", id, name, status, clip(b.client, 100) || null, clip(b.note, 300) || null);
    } catch { return bad("同じIDの案件が既にあります", 409); }
    await log(db, "human", "project", id, "created", null, { name, status }, null);
    return json({ id }, 201);
  }
  let m = path.match(/^\/projects\/([\w-]+)$/);
  if (m && method === "GET") {
    const d = await projectDetail(db, m[1]);
    return d ? json(d) : bad("案件が見つかりません", 404);
  }
  if (m && method === "PATCH") {
    const b = await body();
    const p = await one(db, "SELECT * FROM pm_projects WHERE id=?", m[1]);
    if (!p) return bad("案件が見つかりません", 404);
    const next = {
      name: b?.name !== undefined ? clip(b.name, 100) || p.name : p.name,
      status: ["active", "paused", "done", "unknown"].includes(b?.status) ? b.status : p.status,
      client: b?.client !== undefined ? clip(b.client, 100) || null : p.client,
      note: b?.note !== undefined ? clip(b.note, 300) || null : p.note,
    };
    await run(db, "UPDATE pm_projects SET name=?, status=?, client=?, note=?, updated_at=? WHERE id=?", next.name, next.status, next.client, next.note, nowIso(), p.id);
    await log(db, "human", "project", p.id, "edited", { name: p.name, status: p.status }, next, null);
    // 人が設定した進行状態・状況は自動更新で上書きしない
    if (b?.phase !== undefined || b?.status_text !== undefined) {
      const st = await one(db, "SELECT human_fields FROM pm_project_state WHERE project_id=?", p.id);
      const human = new Set(jparse(st?.human_fields, []));
      const sets = {};
      if (b.phase !== undefined) { if (b.phase !== null && !PHASES.includes(b.phase)) return bad("phase が不正です"); sets.phase = b.phase; human.add("phase"); }
      if (b.status_text !== undefined) { sets.status_text = clip(b.status_text, 300) || null; human.add("status_text"); }
      const cols = Object.keys(sets);
      await run(db, `INSERT INTO pm_project_state (project_id, ${cols.join(", ")}, human_fields, updated_at) VALUES (?, ${cols.map(() => "?").join(", ")}, ?, ?)
                     ON CONFLICT(project_id) DO UPDATE SET ${cols.map((c) => `${c}=excluded.${c}`).join(", ")}, human_fields=excluded.human_fields, updated_at=excluded.updated_at`,
        p.id, ...cols.map((c) => sets[c]), JSON.stringify([...human]), nowIso());
    }
    return json({ ok: true });
  }
  m = path.match(/^\/projects\/([\w-]+)\/links$/);
  if (m && method === "POST") {
    const b = await body();
    if (!(await one(db, "SELECT 1 FROM pm_projects WHERE id=?", m[1]))) return bad("案件が見つかりません", 404);
    const l = { source_kind: clip(b?.source_kind, 40), ref_type: clip(b?.ref_type, 40), ref_value: clip(b?.ref_value, 300), label: clip(b?.label, 100) || null };
    if (!l.source_kind || !l.ref_type || !l.ref_value) return bad("source_kind / ref_type / ref_value が必要です");
    await run(db, "INSERT OR IGNORE INTO pm_project_links (project_id, source_kind, ref_type, ref_value, label) VALUES (?,?,?,?,?)", m[1], l.source_kind, l.ref_type, l.ref_value, l.label);
    return json({ ok: true }, 201);
  }
  m = path.match(/^\/links\/(\d+)$/);
  if (m && method === "DELETE") {
    await run(db, "DELETE FROM pm_project_links WHERE id=?", Number(m[1]));
    return json({ ok: true });
  }

  // 情報源
  if (path === "/sources" && method === "GET") {
    const now = Date.now();
    return json({ sources: (await all(db, "SELECT * FROM pm_sources ORDER BY id")).map((s) => sourceHealth(s, now)) });
  }
  if (path === "/sources" && method === "POST") {
    const b = await body();
    const id = clip(b?.id, 60), kind = clip(b?.kind, 40), name = clip(b?.name, 100);
    if (!id || !kind || !name) return bad("id / kind / name が必要です");
    try {
      await run(db, "INSERT INTO pm_sources (id, kind, name, interval_min, config, note) VALUES (?,?,?,?,?,?)",
        id, kind, name, Math.max(Number(b.interval_min) || 60, 15), JSON.stringify(b.config || {}), clip(b.note, 300) || null);
    } catch { return bad("同じIDの情報源が既にあります", 409); }
    return json({ id }, 201);
  }
  m = path.match(/^\/sources\/([\w-]+)$/);
  if (m && method === "PATCH") {
    const b = await body();
    const s = await one(db, "SELECT * FROM pm_sources WHERE id=?", m[1]);
    if (!s) return bad("情報源が見つかりません", 404);
    await run(db, "UPDATE pm_sources SET name=?, enabled=?, interval_min=?, config=?, note=? WHERE id=?",
      b?.name !== undefined ? clip(b.name, 100) || s.name : s.name,
      b?.enabled !== undefined ? (b.enabled ? 1 : 0) : s.enabled,
      b?.interval_min !== undefined ? Math.max(Number(b.interval_min) || s.interval_min, 15) : s.interval_min,
      b?.config !== undefined ? JSON.stringify(b.config || {}) : s.config,
      b?.note !== undefined ? clip(b.note, 300) || null : s.note, s.id);
    await log(db, "human", "source", s.id, "edited", null, b, null);
    return json({ ok: true });
  }
  m = path.match(/^\/sources\/([\w-]+)\/resync$/);
  if (m && method === "POST") {
    const r = await run(db, "UPDATE pm_sources SET resync_requested_at=? WHERE id=?", nowIso(), m[1]);
    return r.meta.changes ? json({ ok: true, note: "次回の取得時に全体を再確認します" }) : bad("情報源が見つかりません", 404);
  }

  // タスク（人による追加・修正）
  if (path === "/tasks" && method === "POST") {
    const b = await body();
    const title = clip(b?.title, 200);
    if (!title || !(await one(db, "SELECT 1 FROM pm_projects WHERE id=?", b?.project_id))) return bad("project_id と title が必要です");
    if (b.due && !DATE_RE.test(b.due)) return bad("due が不正です");
    const id = "T-" + crypto.randomUUID().slice(0, 8);
    const at = nowIso();
    const waiting = WAIT_ON.includes(b.waiting_on) ? b.waiting_on : null;
    await run(db, `INSERT INTO pm_tasks (id, project_id, title, fingerprint, status, assignee, due, waiting_on, origin, human_edited, human_fields, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?, 'manual', 1, '[]', ?, ?)`,
      id, b.project_id, title, fingerprint(title), waiting ? "waiting" : "open", clip(b.assignee, 60) || null, b.due || null, waiting, at, at);
    await log(db, "human", "task", id, "created", null, { title }, null);
    return json({ id }, 201);
  }
  m = path.match(/^\/tasks\/([\w-]+)$/);
  if (m && method === "PATCH") {
    const r = await humanPatchTask(db, m[1], (await body()) || {});
    return r.error ? bad(r.error, r.status || 400) : json({ ok: true });
  }

  // 提案: 採用・保留・却下
  m = path.match(/^\/suggestions\/(\d+)\/(adopt|hold|reject|reopen)$/);
  if (m && method === "POST") {
    const r = await suggestionAction(db, Number(m[1]), m[2]);
    return r.error ? bad(r.error, r.status || 400) : json(r);
  }

  // 確認事項
  if (path === "/review" && method === "GET") {
    const rows = (await all(db, "SELECT * FROM pm_review_items WHERE status='open' ORDER BY created_at")).map((r) => ({ ...r, options: jparse(r.options, []), context: jparse(r.context, {}) }));
    return json({ items: rows });
  }
  if (path === "/review/answer" && method === "POST") {
    const b = await body();
    const list = Array.isArray(b?.answers) ? b.answers.slice(0, 100) : [];
    const results = [];
    for (const a of list) results.push({ id: a.id, ...(await answerReview(db, Number(a.id), a.answer)) });
    return json({ results });
  }
  m = path.match(/^\/review\/(\d+)\/dismiss$/);
  if (m && method === "POST") {
    await run(db, "UPDATE pm_review_items SET status='dismissed', resolved_at=? WHERE id=? AND status='open'", nowIso(), Number(m[1]));
    return json({ ok: true });
  }

  // 誤った案件紐づけの修正
  m = path.match(/^\/activities\/(\d+)\/assign$/);
  if (m && method === "POST") {
    const b = await body();
    const a = await one(db, "SELECT source_id, ref FROM pm_activities WHERE id=?", Number(m[1]));
    if (!a) return bad("活動記録が見つかりません", 404);
    if (b?.project_id === "__ignore__") { await excludeActivityRef(db, a.source_id, a.ref); return json({ ok: true }); }
    if (!(await one(db, "SELECT 1 FROM pm_projects WHERE id=?", b?.project_id))) return bad("project_id が不正です");
    const r = await assignActivityRef(db, a.source_id, a.ref, b.project_id);
    return r.error ? bad(r.error, r.status || 400) : json(r);
  }
  if (path === "/activities/unassigned" && method === "GET") {
    return json({ activities: await all(db, "SELECT id, source_id, ref, occurred_at, kind, summary, url, link_reason FROM pm_activities WHERE project_id IS NULL AND excluded=0 ORDER BY occurred_at DESC LIMIT 100") });
  }

  if (path === "/log" && method === "GET") {
    return json({ log: await all(db, "SELECT * FROM pm_change_log ORDER BY id DESC LIMIT 100") });
  }

  return bad("Not found", 404);
}

// 取得結果（バッチ）を案件ボードへ反映する処理。
// AIが出した内容は「データ」として扱い、ここで根拠・形式・矛盾を検証してから保存する。
// 同じバッチを何度反映しても重複しないよう、すべて指紋(fingerprint)で照合する。

export const PHASES = [
  "preparing", "in_progress", "review_pending", "client_pending",
  "material_pending", "permission_pending", "stopped", "done",
];
export const WAIT_ON = ["client", "material", "permission", "internal"];
export const ACTIVE_STATUSES = ["open", "in_progress", "waiting"];
const MILESTONES = ["produced", "client_approved", "published"];
const COMPLETION_OK = ["explicit_record", "tool_state"]; // これ以外（ファイル更新だけ等）では完了にしない
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const clip = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
const jparse = (s, fallback) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};

export const DEFAULT_SETTINGS = {
  self_names: [],
  stale_days: 7,
  retention_days: 180,
  snippet_max_chars: 200,
  ai_scope: {
    include: ["subject", "body_head", "sender_name", "file_title", "file_text_diff"],
    body_max_chars: 1500,
    exclude: ["private_mail", "personal_documents", "credentials"],
  },
  denylist: {
    folder_names: ["10_本人確認書類", "08_家計簿"],
    file_name_patterns: ["recovery", "password", "secret", "token", "tfa", "パスワード", "認証コード"],
  },
};

export async function getSettings(db) {
  const { results } = await db.prepare("SELECT key, value FROM pm_settings").all();
  const s = structuredClone(DEFAULT_SETTINGS);
  for (const r of results) s[r.key] = jparse(r.value, s[r.key]);
  return s;
}

// ---------- 文字列の正規化・類似判定 ----------

export const fingerprint = (s) =>
  String(s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s　、。，．,.!！?？・:：;；「」『』()（）[\]【】"'“”‘’~〜_-]/g, "")
    .slice(0, 160);

function bigrams(s) {
  const out = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}
export function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a), B = bigrams(b);
  let inter = 0;
  for (const [g, n] of A) inter += Math.min(n, B.get(g) || 0);
  return (2 * inter) / (a.length - 1 + b.length - 1);
}
const SAME_TASK_SIMILARITY = 0.85;

// ---------- 入力の検証 ----------

function cleanEvidence(list, sourceId, snippetMax) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list.slice(0, 10)) {
    const ref = clip(e?.ref, 300);
    if (!ref) continue;
    out.push({
      source_id: sourceId,
      ref,
      locator: clip(e.locator, 200),
      at: clip(e.at, 40),
      quote: clip(e.quote, snippetMax),
      url: /^https?:\/\//.test(e?.url || "") ? clip(e.url, 500) : "",
    });
  }
  return out;
}

export function validateBatch(raw, settings) {
  const errors = [];
  if (!raw || typeof raw !== "object") return { ok: false, errors: ["batch が不正です"] };
  const sourceId = clip(raw.source_id, 100);
  if (!sourceId) errors.push("source_id が必要です");
  const run = raw.run || {};
  const status = ["ok", "partial", "failed"].includes(run.status) ? run.status : null;
  if (!status) errors.push("run.status は ok / partial / failed のいずれかです");
  if (errors.length) return { ok: false, errors };

  const max = settings.snippet_max_chars;
  const activities = (Array.isArray(raw.activities) ? raw.activities : []).slice(0, 500).flatMap((a) => {
    const ref = clip(a?.ref, 300), hash = clip(a?.hash, 100);
    const at = clip(a?.occurred_at, 40);
    if (!ref || !hash || !at || Number.isNaN(Date.parse(at))) return [];
    return [{
      ref, hash, occurred_at: new Date(at).toISOString().replace(/\.\d+Z$/, "Z"),
      kind: clip(a.kind, 40) || "other",
      summary: clip(a.summary, 200) || "(要約なし)",
      snippet: clip(a.snippet, max),
      url: /^https?:\/\//.test(a.url || "") ? clip(a.url, 500) : "",
      group_keys: (Array.isArray(a.group_keys) ? a.group_keys : []).slice(0, 10).flatMap((g) =>
        g?.type && g?.value ? [{ type: clip(g.type, 40), value: clip(g.value, 300) }] : []),
      project_id: clip(a.project_id, 40) || null,
      candidates: (Array.isArray(a.candidates) ? a.candidates : []).slice(0, 5).map((c) => clip(c, 40)).filter(Boolean),
    }];
  });

  const items = (Array.isArray(raw.items) ? raw.items : []).slice(0, 500).map((it) => ({
    ...it,
    evidence: cleanEvidence(it?.evidence, sourceId, max),
  }));

  return {
    ok: true,
    batch: {
      source_id: sourceId,
      run: {
        status,
        started_at: clip(run.started_at, 40),
        finished_at: clip(run.finished_at, 40),
        error: clip(run.error, 500),
        cursor: run.cursor != null ? clip(String(run.cursor), 500) : null,
        resync_handled: !!run.resync_handled,
      },
      activities,
      items,
    },
  };
}

// ---------- DB ヘルパー ----------

const one = (db, sql, ...b) => db.prepare(sql).bind(...b).first();
const all = async (db, sql, ...b) => (await db.prepare(sql).bind(...b).all()).results;
const run = (db, sql, ...b) => db.prepare(sql).bind(...b).run();

export async function log(db, actor, entity, entityId, action, before, after, reason) {
  await run(
    db,
    "INSERT INTO pm_change_log (at, actor, entity, entity_id, action, before, after, reason) VALUES (?,?,?,?,?,?,?,?)",
    nowIso(), actor, entity, String(entityId), action,
    before == null ? null : JSON.stringify(before),
    after == null ? null : JSON.stringify(after),
    reason || null
  );
}

// 同じ不明点は一度しか作らない（回答・却下済みでも再作成しない）
export async function ensureReview(db, r) {
  const res = await run(
    db,
    `INSERT OR IGNORE INTO pm_review_items (fingerprint, kind, project_id, question, options, context, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    r.fingerprint.slice(0, 300), r.kind, r.project_id || null, clip(r.question, 400),
    JSON.stringify(r.options || []), JSON.stringify(r.context || {}), nowIso()
  );
  return res.meta.changes > 0;
}

function mergeEvidence(existing, incoming) {
  const out = [...existing];
  const key = (e) => `${e.source_id}|${e.ref}|${e.locator}`;
  const seen = new Set(out.map(key));
  for (const e of incoming) if (!seen.has(key(e))) { out.push(e); seen.add(key(e)); }
  return out.slice(-20);
}

// ---------- 案件への紐づけ ----------

async function resolveProject(ctx, { project_id, group_keys = [], candidates = [] }) {
  const { db } = ctx;
  const valid = async (id) => (id ? await one(db, "SELECT id, status FROM pm_projects WHERE id=?", id) : null);

  // 1) 台帳の対応関係（フォルダ・ラベル・スレッド等）を最優先
  const linked = new Set();
  for (const g of group_keys) {
    const rows = await all(db, "SELECT project_id FROM pm_project_links WHERE ref_type=? AND ref_value=?", g.type, g.value);
    for (const r of rows) linked.add(r.project_id);
  }
  if (linked.size === 1) return { project_id: [...linked][0], reason: "link", candidates: [] };
  if (linked.size > 1) return { project_id: null, reason: "multi", candidates: [...linked] };

  // 2) AIの推定（台帳に存在する案件のみ）
  const cand = [];
  for (const c of candidates) if (await valid(c)) cand.push(c);
  if (cand.length > 1) return { project_id: null, reason: "multi", candidates: cand };
  const hint = (await valid(project_id)) ? project_id : cand[0] || null;
  if (hint) return { project_id: hint, reason: "hint", candidates: [] };
  return { project_id: null, reason: "unassigned", candidates: [] };
}

async function projectOptions(db) {
  const rows = await all(db, "SELECT id, name FROM pm_projects WHERE status != 'done' ORDER BY id");
  return rows.map((p) => ({ value: p.id, label: `${p.id} ${p.name}` }));
}

// ---------- バッチの反映 ----------

export async function applyBatch(db, raw, { settings } = {}) {
  settings = settings || (await getSettings(db));
  const v = validateBatch(raw, settings);
  if (!v.ok) return { ok: false, errors: v.errors };
  const b = v.batch;

  const src = await one(db, "SELECT * FROM pm_sources WHERE id=?", b.source_id);
  if (!src) return { ok: false, errors: [`情報源 ${b.source_id} は登録されていません`] };
  if (!src.enabled) return { ok: false, errors: [`情報源 ${b.source_id} は無効です`] };

  const at = nowIso();
  // 取得失敗: 最後に取得できた情報は一切変更しない（タスクの完了・削除もしない）
  if (b.run.status === "failed") {
    await run(db, "UPDATE pm_sources SET last_attempt_at=?, last_status='failed', last_error=? WHERE id=?", at, b.run.error || "取得に失敗しました", src.id);
    await log(db, "system", "source", src.id, "sync_failed", null, { error: b.run.error }, null);
    return { ok: true, applied: false, stats: { failed: true } };
  }

  const ctx = { db, settings, src, b, stats: { activities: 0, tasks_created: 0, tasks_updated: 0, completed: 0, decisions: 0, suggestions: 0, reviews: 0, held: 0, rejected: [], errors: [] } };

  for (const a of b.activities) await applyActivity(ctx, a);
  for (const item of b.items) {
    try {
      await applyItem(ctx, item);
    } catch (e) {
      ctx.stats.errors.push(`${item?.type}: ${e.message}`);
    }
  }

  await run(
    db,
    `UPDATE pm_sources SET last_attempt_at=?, last_success_at=?, last_status=?, last_error=?, cursor=COALESCE(?, cursor),
       resync_requested_at = CASE WHEN ? THEN NULL ELSE resync_requested_at END WHERE id=?`,
    at, at, b.run.status, b.run.status === "partial" ? b.run.error || "一部の取得に失敗しました" : null,
    b.run.cursor, b.run.resync_handled ? 1 : 0, src.id
  );
  return { ok: true, applied: true, stats: ctx.stats };
}

async function applyActivity(ctx, a) {
  const { db, src, stats } = ctx;
  const res = await resolveProject(ctx, a);
  const ins = await run(
    db,
    `INSERT OR IGNORE INTO pm_activities
       (source_id, ref, hash, occurred_at, kind, summary, snippet, url, group_keys, project_id, link_reason, candidates, collected_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    src.id, a.ref, a.hash, a.occurred_at, a.kind, a.summary, a.snippet || null, a.url || null,
    JSON.stringify(a.group_keys), res.project_id, res.reason, JSON.stringify(res.candidates), nowIso()
  );
  if (!ins.meta.changes) return; // 内容が変わっていない既知の情報は再処理しない
  stats.activities++;

  if (res.project_id) {
    await run(
      db,
      `INSERT INTO pm_project_state (project_id, updated_at, last_activity_at) VALUES (?,?,?)
       ON CONFLICT(project_id) DO UPDATE SET last_activity_at = MAX(COALESCE(last_activity_at,''), excluded.last_activity_at)`,
      res.project_id, nowIso(), a.occurred_at
    );
    return;
  }
  // 案件を特定できない／複数案件にまたがる情報は、無理に割り当てず確認事項へ
  const options = res.reason === "multi"
    ? [...(await projectOptions(db)).filter((o) => res.candidates.includes(o.value)), { value: "__ignore__", label: "どれにも属さない（対象外）" }]
    : [...(await projectOptions(db)), { value: "__ignore__", label: "対象外（収集しない）" }];
  const created = await ensureReview(db, {
    fingerprint: `${res.reason}:${src.id}:${a.ref}`,
    kind: res.reason === "multi" ? "multi_project" : "unassigned_activity",
    question: `「${a.summary}」はどの案件ですか？`,
    options,
    context: { source_id: src.id, ref: a.ref, hash: a.hash, url: a.url || null, occurred_at: a.occurred_at },
  });
  if (created) stats.reviews++;
}

async function projectForItem(ctx, item) {
  const { db, src } = ctx;
  if (item.project_id) {
    const r = await resolveProject(ctx, { project_id: item.project_id, candidates: item.candidates || [] });
    if (r.project_id) return r;
  }
  // 根拠となる活動記録の案件が一致していればそれを使う
  const ids = new Set();
  for (const e of item.evidence) {
    const row = await one(db, "SELECT project_id FROM pm_activities WHERE source_id=? AND ref=? AND excluded=0 ORDER BY id DESC LIMIT 1", src.id, e.ref);
    if (row?.project_id) ids.add(row.project_id);
  }
  if (ids.size === 1) return { project_id: [...ids][0], reason: "evidence" };
  return { project_id: null, reason: ids.size > 1 ? "multi" : "unassigned" };
}

async function applyItem(ctx, item) {
  const { db, stats } = ctx;
  if (!item || typeof item.type !== "string") return;

  if (item.type === "question") {
    const proj = await projectForItem(ctx, item);
    const q = clip(item.question, 400);
    if (!q) return;
    const created = await ensureReview(db, {
      fingerprint: `question:${proj.project_id || "-"}:${fingerprint(q)}`,
      kind: "question", project_id: proj.project_id, question: q,
      options: [], context: { evidence: item.evidence, note: clip(item.note, 300) },
    });
    if (created) stats.reviews++;
    return;
  }

  if (!["task", "completion", "cancel", "decision", "state", "suggestion"].includes(item.type)) {
    stats.rejected.push(`不明な type: ${String(item.type).slice(0, 30)}`);
    return;
  }
  if (!item.evidence.length) {
    stats.rejected.push(`${item.type}: 根拠がないため反映しません`);
    return;
  }

  const proj = await projectForItem(ctx, item);
  if (!proj.project_id) {
    // 案件が決まるまで保留（紐づけの回答後に反映）
    await run(db, "INSERT INTO pm_held_items (source_id, activity_ref, item, created_at) VALUES (?,?,?,?)",
      ctx.src.id, item.evidence[0].ref, JSON.stringify(item), nowIso());
    stats.held++;
    return;
  }
  await applyItemToProject(ctx, item, proj.project_id);
}

export async function applyItemToProject(ctx, item, projectId) {
  switch (item.type) {
    case "task": return upsertTask(ctx, item, projectId);
    case "completion": return applyCompletion(ctx, item, projectId);
    case "cancel": return applyCancel(ctx, item, projectId);
    case "decision": return upsertDecision(ctx, item, projectId);
    case "state": return applyState(ctx, item, projectId);
    case "suggestion": return upsertSuggestion(ctx, item, projectId);
  }
}

// ---------- タスク ----------

async function findTask(db, projectId, { task_id, title }) {
  if (task_id) {
    const t = await one(db, "SELECT * FROM pm_tasks WHERE id=? AND project_id=?", task_id, projectId);
    if (t) return t;
  }
  const fp = fingerprint(title);
  if (!fp) return null;
  const rows = await all(db, "SELECT * FROM pm_tasks WHERE project_id=?", projectId);
  const exact = rows.find((t) => t.fingerprint === fp);
  if (exact) return exact;
  let best = null, score = 0;
  for (const t of rows) {
    const s = similarity(fp, t.fingerprint);
    if (s >= SAME_TASK_SIMILARITY && s > score) { best = t; score = s; }
  }
  return best;
}

// 期限・担当は「根拠の引用」があるときだけ採用する（推測で確定しない）
function claimed(item, field) {
  const ev = clip(item[`${field}_evidence`], 200);
  const value = field === "due" ? (DATE_RE.test(item.due || "") ? item.due : null) : clip(item.assignee, 60) || null;
  return value && ev ? value : null;
}

async function upsertTask(ctx, item, projectId) {
  const { db, stats } = ctx;
  const title = clip(item.title, 200);
  if (!title) return;
  const due = claimed(item, "due");
  const assignee = claimed(item, "assignee");
  const waitingOn = WAIT_ON.includes(item.waiting_on) ? item.waiting_on : null;
  const waitingDetail = clip(item.waiting_detail, 200) || null;
  if (item.due && !due) stats.rejected.push(`期限「${item.due}」は根拠がないため採用しません: ${title}`);
  if (item.assignee && !assignee) stats.rejected.push(`担当「${item.assignee}」は根拠がないため採用しません: ${title}`);

  const t = await findTask(db, projectId, { title });
  const at = nowIso();

  if (!t) {
    const id = "T-" + crypto.randomUUID().slice(0, 8);
    const status = waitingOn ? "waiting" : item.status === "in_progress" ? "in_progress" : "open";
    await run(
      db,
      `INSERT INTO pm_tasks (id, project_id, title, fingerprint, status, assignee, due, waiting_on, waiting_detail, origin, evidence, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?, 'ai_extracted', ?,?,?)`,
      id, projectId, title, fingerprint(title), status, assignee, due, waitingOn, waitingDetail, JSON.stringify(item.evidence), at, at
    );
    await log(db, "system", "task", id, "created", null, { title, status, due, assignee, waiting_on: waitingOn }, null);
    stats.tasks_created++;
    return;
  }

  // 既存タスクの更新
  const human = jparse(t.human_fields, []);
  const evidence = mergeEvidence(jparse(t.evidence, []), item.evidence);
  const changes = {};
  const finished = ["done", "cancelled"].includes(t.status);

  const incoming = { due, assignee, waiting_on: waitingOn };
  for (const [field, value] of Object.entries(incoming)) {
    if (value == null || finished) continue;
    const current = t[field];
    if (current === value) continue;
    if (current == null && !human.includes(field)) { changes[field] = value; continue; }
    if (!human.includes(field) && item.explicit_change === true) { changes[field] = value; continue; } // 期限変更など明示された変更
    // 人が直した値・根拠のない食い違いは自動で上書きせず確認へ
    const label = { due: "期限", assignee: "担当", waiting_on: "待ち先" }[field];
    const created = await ensureReview(db, {
      fingerprint: `conflict:${t.id}:${field}:${value}`,
      kind: "conflict", project_id: projectId,
      question: `「${t.title}」の${label}が食い違っています。どちらが正しいですか？`,
      options: [
        { value: "existing", label: `現在の値を維持（${current ?? "未設定"}）` },
        { value: "incoming", label: `新しい情報に更新（${value}）` },
      ],
      context: { task_id: t.id, field, existing: current, incoming: value, evidence: item.evidence },
    });
    if (created) stats.reviews++;
  }
  // 待ち先が付いたら「待ち」状態に。待ちの解消が根拠つきで明示された場合は解除する
  if (!finished && waitingOn && (changes.waiting_on || t.waiting_on === waitingOn) && t.status === "open") changes.status = "waiting";
  if (!finished && item.clear_waiting === true && t.waiting_on && !human.includes("waiting_on") && !human.includes("status")) {
    changes.waiting_on = null;
    changes.waiting_detail = null;
    if (t.status === "waiting") changes.status = "open";
  }
  if (waitingDetail && !finished && waitingDetail !== t.waiting_detail && !human.includes("waiting_detail")) changes.waiting_detail = waitingDetail;

  const sets = Object.keys(changes);
  const evChanged = JSON.stringify(evidence) !== t.evidence;
  if (!sets.length && !evChanged) return;
  const cols = [...sets.map((k) => `${k}=?`), "evidence=?", "updated_at=?"];
  await run(db, `UPDATE pm_tasks SET ${cols.join(", ")} WHERE id=?`, ...sets.map((k) => changes[k]), JSON.stringify(evidence), at, t.id);
  if (sets.length) {
    await log(db, "system", "task", t.id, "updated", Object.fromEntries(sets.map((k) => [k, t[k]])), changes, item.explicit_change ? "明示的な変更" : null);
    stats.tasks_updated++;
  }
}

async function applyCompletion(ctx, item, projectId) {
  const { db, stats } = ctx;
  const t = await findTask(db, projectId, { task_id: item.task_id, title: item.title });
  const basis = item.basis;

  if (!COMPLETION_OK.includes(basis)) {
    // ファイルの更新だけでは完了にしない。完了判断は確認へ（同じ確認は繰り返さない）
    const title = t?.title || clip(item.title, 200);
    const created = await ensureReview(db, {
      fingerprint: `completion:${projectId}:${t?.id || fingerprint(title)}`,
      kind: "completion_unclear", project_id: projectId,
      question: `「${title}」が完了したか判断できません（${basis === "file_updated" ? "ファイルが更新されたのみ" : "明確な完了記録がありません"}）。完了にしますか？`,
      options: [{ value: "done", label: "完了にする" }, { value: "not_done", label: "まだ完了していない" }],
      context: { task_id: t?.id || null, title, evidence: item.evidence },
    });
    if (created) stats.reviews++;
    return;
  }

  const at = nowIso();
  if (MILESTONES.includes(item.milestone)) {
    const st = await one(db, "SELECT milestones FROM pm_project_state WHERE project_id=?", projectId);
    const ms = jparse(st?.milestones, {});
    if (!ms[item.milestone]) {
      ms[item.milestone] = { at, basis, evidence: item.evidence.slice(0, 3) };
      await run(
        db,
        `INSERT INTO pm_project_state (project_id, milestones, updated_at) VALUES (?,?,?)
         ON CONFLICT(project_id) DO UPDATE SET milestones=excluded.milestones, updated_at=excluded.updated_at`,
        projectId, JSON.stringify(ms), at
      );
      await log(db, "system", "project", projectId, `milestone_${item.milestone}`, null, ms[item.milestone], null);
    }
  }

  if (!t) {
    const title = clip(item.title, 200);
    if (!title) return;
    const id = "T-" + crypto.randomUUID().slice(0, 8);
    await run(
      db,
      `INSERT INTO pm_tasks (id, project_id, title, fingerprint, status, completion_basis, origin, evidence, created_at, updated_at, done_at)
       VALUES (?,?,?,?, 'done', ?, 'ai_extracted', ?,?,?,?)`,
      id, projectId, title, fingerprint(title), basis, JSON.stringify(item.evidence), at, at, at
    );
    await log(db, "system", "task", id, "created_done", null, { title, basis }, null);
    stats.completed++;
    return;
  }
  if (t.status === "done" || t.status === "cancelled") return;
  if (jparse(t.human_fields, []).includes("status")) {
    const created = await ensureReview(db, {
      fingerprint: `conflict:${t.id}:status:done`,
      kind: "conflict", project_id: projectId,
      question: `「${t.title}」に完了記録がありますが、手動で変更された状態があります。完了にしますか？`,
      options: [{ value: "incoming", label: "完了にする" }, { value: "existing", label: "現在の状態を維持" }],
      context: { task_id: t.id, field: "status", existing: t.status, incoming: "done", evidence: item.evidence },
    });
    if (created) stats.reviews++;
    return;
  }
  const evidence = mergeEvidence(jparse(t.evidence, []), item.evidence);
  await run(db, "UPDATE pm_tasks SET status='done', completion_basis=?, done_at=?, evidence=?, updated_at=? WHERE id=?",
    basis, at, JSON.stringify(evidence), at, t.id);
  await log(db, "system", "task", t.id, "completed", { status: t.status }, { status: "done", basis }, null);
  stats.completed++;
}

async function applyCancel(ctx, item, projectId) {
  const { db, stats } = ctx;
  const t = await findTask(db, projectId, { task_id: item.task_id, title: item.title });
  if (!t || ["done", "cancelled"].includes(t.status)) return;
  if (jparse(t.human_fields, []).includes("status")) {
    const created = await ensureReview(db, {
      fingerprint: `conflict:${t.id}:status:cancelled`,
      kind: "conflict", project_id: projectId,
      question: `「${t.title}」に取消の記録がありますが、手動で変更された状態があります。取り消しますか？`,
      options: [{ value: "incoming", label: "取り消す" }, { value: "existing", label: "現在の状態を維持" }],
      context: { task_id: t.id, field: "status", existing: t.status, incoming: "cancelled", evidence: item.evidence },
    });
    if (created) stats.reviews++;
    return;
  }
  const at = nowIso();
  await run(db, "UPDATE pm_tasks SET status='cancelled', evidence=?, updated_at=? WHERE id=?",
    JSON.stringify(mergeEvidence(jparse(t.evidence, []), item.evidence)), at, t.id);
  await log(db, "system", "task", t.id, "cancelled", { status: t.status }, { status: "cancelled" }, "取消の記録");
  stats.tasks_updated++;
}

// ---------- 決定事項・状況・提案 ----------

async function upsertDecision(ctx, item, projectId) {
  const { db, stats } = ctx;
  const text = clip(item.text, 400);
  if (!text) return;
  const fp = fingerprint(text);
  const decidedAt = clip(item.decided_at, 40) || null;
  const existing = await one(db, "SELECT * FROM pm_decisions WHERE project_id=? AND fingerprint=?", projectId, fp);
  if (existing) {
    const merged = mergeEvidence(jparse(existing.evidence, []), item.evidence);
    if (JSON.stringify(merged) !== existing.evidence) await run(db, "UPDATE pm_decisions SET evidence=? WHERE id=?", JSON.stringify(merged), existing.id);
    return;
  }
  await run(db, "INSERT INTO pm_decisions (project_id, text, fingerprint, decided_at, evidence, created_at) VALUES (?,?,?,?,?,?)",
    projectId, text, fp, decidedAt, JSON.stringify(item.evidence), nowIso());
  await log(db, "system", "decision", projectId, "created", null, { text }, null);
  stats.decisions++;
}

async function upsertSuggestion(ctx, item, projectId) {
  const { db, stats } = ctx;
  const text = clip(item.text, 400);
  if (!text) return;
  const fp = fingerprint(text);
  const existing = await one(db, "SELECT * FROM pm_suggestions WHERE project_id=? AND fingerprint=?", projectId, fp);
  if (existing) {
    // 採用・保留・却下済みの提案は再提案しない
    const merged = mergeEvidence(jparse(existing.evidence, []), item.evidence);
    if (JSON.stringify(merged) !== existing.evidence) await run(db, "UPDATE pm_suggestions SET evidence=? WHERE id=?", JSON.stringify(merged), existing.id);
    return;
  }
  await run(db, "INSERT INTO pm_suggestions (project_id, text, rationale, fingerprint, evidence, created_at) VALUES (?,?,?,?,?,?)",
    projectId, text, clip(item.rationale, 400) || null, fp, JSON.stringify(item.evidence), nowIso());
  stats.suggestions++;
}

async function applyState(ctx, item, projectId) {
  const { db, stats } = ctx;
  const st = await one(db, "SELECT * FROM pm_project_state WHERE project_id=?", projectId);
  const human = jparse(st?.human_fields, []);
  const at = nowIso();
  const next = {
    phase: PHASES.includes(item.phase) ? item.phase : null,
    status_text: clip(item.status_text, 300) || null,
    stalled_reason: clip(item.stalled_reason, 300) || null,
  };
  const unknowns = (Array.isArray(item.unknowns) ? item.unknowns : []).map((u) => clip(u, 200)).filter(Boolean).slice(0, 10);

  const apply = {};
  for (const [field, value] of Object.entries(next)) {
    if (value == null || st?.[field] === value) continue;
    if (human.includes(field)) {
      const created = await ensureReview(db, {
        fingerprint: `state:${projectId}:${field}:${value}`,
        kind: "state_conflict", project_id: projectId,
        question: `案件の${field === "phase" ? "進行状態" : "状況"}が、手動で設定した内容と食い違っています。どちらを採用しますか？`,
        options: [{ value: "existing", label: `現在の設定を維持（${st[field] ?? "未設定"}）` }, { value: "incoming", label: `新しい情報に更新（${value}）` }],
        context: { project_id: projectId, field, existing: st[field], incoming: value, evidence: item.evidence },
      });
      if (created) stats.reviews++;
      continue;
    }
    apply[field] = value;
  }
  const evidence = mergeEvidence(jparse(st?.evidence, []), item.evidence);
  const cols = { ...apply, evidence: JSON.stringify(evidence), updated_at: at };
  if (unknowns.length) cols.unknowns = JSON.stringify(unknowns);
  const keys = Object.keys(cols);
  await run(
    db,
    `INSERT INTO pm_project_state (project_id, ${keys.join(", ")}) VALUES (?, ${keys.map(() => "?").join(", ")})
     ON CONFLICT(project_id) DO UPDATE SET ${keys.map((k) => `${k}=excluded.${k}`).join(", ")}`,
    projectId, ...keys.map((k) => cols[k])
  );
  if (Object.keys(apply).length) await log(db, "system", "project", projectId, "state_updated", st && Object.fromEntries(Object.keys(apply).map((k) => [k, st[k]])), apply, null);
}

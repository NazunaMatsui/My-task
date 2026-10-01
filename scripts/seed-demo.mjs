// 画面確認用の架空データを投入する（手動実行のみ。実際の案件データとは無関係）
//   事前に .dev.vars に INGEST_TOKEN=dev-token を書いて npm start を起動しておく
//   node scripts/seed-demo.mjs [http://localhost:8787]
const base = process.argv[2] || "http://localhost:8787";
const token = process.env.INGEST_TOKEN || "dev-token";
const call = async (method, path, body, auth) => {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
};
const ingest = (b) => call("POST", "/api/pm/ingest", b, `Bearer ${token}`);
const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();
const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
const shift = (n) => new Date(Date.parse(today + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const ev = (ref, quote, minAgo = 120, locator = "本文") => [{ ref, locator, at: iso(minAgo), quote, url: "https://example.com/demo/" + ref }];

await call("PUT", "/api/pm/settings", { self_names: ["松井"] });
await call("POST", "/api/pm/projects", { id: "D-001", name: "デモ：ヘアサロンLP", status: "active", client: "A社（架空）" });
await call("POST", "/api/pm/projects", { id: "D-002", name: "デモ：広告運用", status: "active", client: "B社（架空）" });
await call("POST", "/api/pm/sources", { id: "demo-gmail", kind: "gmail", name: "Gmail（デモ）", interval_min: 60 });
await call("POST", "/api/pm/sources", { id: "demo-drive", kind: "drive", name: "Google ドライブ（デモ）", interval_min: 60 });
await call("POST", "/api/pm/projects/D-001/links", { source_kind: "drive", ref_type: "drive_folder", ref_value: "demo-folder-lp" });

const ok = { status: "ok", started_at: iso(2), finished_at: iso(1) };
await ingest({ source_id: "demo-gmail", run: ok,
  activities: [
    { ref: "demo-m1", hash: "1", occurred_at: iso(180), kind: "mail", summary: "LP初稿を先方へ送付", snippet: "LP初稿を先方へ送付。写真は未着。広告開始日は未定", group_keys: [{ type: "gmail_thread", value: "demo-th1" }], project_id: "D-001" },
    { ref: "demo-m2", hash: "1", occurred_at: iso(40), kind: "mail", summary: "見積書の件（案件不明）", group_keys: [{ type: "gmail_thread", value: "demo-th9" }] },
  ],
  items: [
    { type: "state", project_id: "D-001", phase: "client_pending", status_text: "LP初稿の確認待ち", unknowns: ["公開日", "広告開始日"], evidence: ev("demo-m1", "LP初稿を先方へ送付") },
    { type: "task", project_id: "D-001", title: "初稿への返答を待つ", waiting_on: "client", evidence: ev("demo-m1", "LP初稿を先方へ送付") },
    { type: "task", project_id: "D-001", title: "写真の提供を待つ", waiting_on: "material", evidence: ev("demo-m1", "写真は未着") },
    { type: "task", project_id: "D-001", title: "修正指示をバナーに反映する", due: today, due_evidence: "本日中にお願いします", assignee: "松井", assignee_evidence: "松井さんにお願いします", evidence: ev("demo-m3", "本日中に松井さんにお願いします", 90) },
    { type: "task", project_id: "D-001", title: "請求書を送る", due: shift(-2), due_evidence: "先週末までに", evidence: ev("demo-m4", "先週末までに請求書をお願いします", 2000) },
    { type: "decision", project_id: "D-001", text: "ファーストビューは写真を大きく使う方針で確定", decided_at: iso(600), evidence: ev("demo-m5", "ファーストビューは写真大きめでいきましょう", 600) },
    { type: "suggestion", project_id: "D-001", text: "写真の提供予定日と広告開始希望日を先方に確認する", rationale: "写真が未着で、広告開始日が未定のため", evidence: ev("demo-m1", "写真は未着。広告開始日は未定") },
    { type: "task", title: "見積書を再送する", evidence: ev("demo-m2", "見積書をもう一度送ってください", 40) },
  ] });
await ingest({ source_id: "demo-drive", run: ok,
  activities: [{ ref: "demo-f1@v2", hash: "1", occurred_at: iso(300), kind: "file_update", summary: "進行メモを更新", group_keys: [{ type: "drive_folder", value: "demo-folder-lp" }] }],
  items: [{ type: "completion", project_id: "D-001", title: "バナー初稿", basis: "file_updated", evidence: ev("demo-f1@v2", "banner-v2.psd が更新", 300, "ファイル更新") }] });
await ingest({ source_id: "demo-gmail", run: { status: "failed", error: "認証の有効期限が切れました（デモ）" }, activities: [], items: [] });
console.log("デモデータを投入しました。", base + "/board.html");

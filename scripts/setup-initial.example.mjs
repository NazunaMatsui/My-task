// 初期設定の雛形（案件台帳と情報源の対応を登録する）。
// 実際の案件名・フォルダIDを入れたものは local/setup-initial.mjs として保存する（local/ は .gitignore 済みで公開されない）。
//   node local/setup-initial.mjs <ボードのURL> [パスワード]
const base = process.argv[2] || "http://localhost:8787";
const password = process.argv[3] || process.env.APP_PASSWORD || "";
const auth = password ? { authorization: "Basic " + Buffer.from("u:" + password).toString("base64") } : {};
async function call(method, path, body) {
  const res = await fetch(base + path, { method, headers: { "content-type": "application/json", ...auth }, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 409) return { skipped: true }; // 既にある
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

await call("POST", "/api/pm/projects", { id: "P-001", name: "案件名", status: "active", client: "クライアント名" });
await call("POST", "/api/pm/projects/P-001/links", { source_kind: "drive", ref_type: "drive_folder", ref_value: "<ドライブのフォルダID>", label: "案件フォルダ" });
await call("POST", "/api/pm/sources", { id: "drive-main", kind: "drive", name: "Google ドライブ", interval_min: 180, config: { roots: ["<ドライブのフォルダID>"] } });
await call("PUT", "/api/pm/settings", { self_names: ["<自分の名前>"], denylist: { folder_names: ["<収集しないフォルダ名>"], sender_patterns: [], label_names: [] } });
console.log("初期設定を登録しました:", base);

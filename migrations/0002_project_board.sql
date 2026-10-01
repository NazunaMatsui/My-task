-- 案件ボード（自動整理）用テーブル
-- 日時はすべて UTC の ISO 8601 文字列 (例: 2026-10-01T04:30:00Z)

-- 案件台帳
CREATE TABLE pm_projects (
  id         TEXT PRIMARY KEY,                       -- 例: P-001
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'unknown',        -- active / paused / done / unknown（人が決める。フォルダの有無では決めない）
  client     TEXT,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- 案件と情報源の対応（フォルダ・ラベル・スレッド・キーワードなど）
CREATE TABLE pm_project_links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL REFERENCES pm_projects(id),
  source_kind TEXT NOT NULL,                         -- gmail / drive / docs / sheets / task_tool / minutes ...
  ref_type    TEXT NOT NULL,                         -- drive_folder / gmail_label / gmail_thread / keyword / url ...
  ref_value   TEXT NOT NULL,
  label       TEXT,
  origin      TEXT NOT NULL DEFAULT 'manual',        -- manual / learned（人が紐づけを直した結果）
  UNIQUE (source_kind, ref_type, ref_value, project_id)
);

-- 情報源と同期状態（初期版は読み取り専用）
CREATE TABLE pm_sources (
  id                  TEXT PRIMARY KEY,              -- 例: gmail-main
  kind                TEXT NOT NULL,
  name                TEXT NOT NULL,
  enabled             INTEGER NOT NULL DEFAULT 1,
  interval_min        INTEGER NOT NULL DEFAULT 60,
  config              TEXT NOT NULL DEFAULT '{}',    -- 取得範囲 (ラベル/フォルダID/除外)
  read_only           INTEGER NOT NULL DEFAULT 1,
  cursor              TEXT,                          -- 差分取得の位置
  last_attempt_at     TEXT,
  last_success_at     TEXT,
  last_status         TEXT,                          -- ok / partial / failed
  last_error          TEXT,
  resync_requested_at TEXT,
  note                TEXT
);

-- 取得した活動記録と出典（本文の全文は保存せず、短い抜粋のみ）
CREATE TABLE pm_activities (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id    TEXT NOT NULL REFERENCES pm_sources(id),
  ref          TEXT NOT NULL,                        -- メッセージID / ファイルID+版 など
  hash         TEXT NOT NULL,                        -- 内容ハッシュ。変更がなければ再処理しない
  occurred_at  TEXT NOT NULL,
  kind         TEXT NOT NULL,                        -- mail / file_update / minutes / task_tool ...
  summary      TEXT NOT NULL,
  snippet      TEXT,
  url          TEXT,
  group_keys   TEXT NOT NULL DEFAULT '[]',           -- [{type,value}] 紐づけ用
  project_id   TEXT REFERENCES pm_projects(id),      -- NULL は未分類
  link_reason  TEXT,                                 -- link / hint / manual / unassigned / multi
  candidates   TEXT NOT NULL DEFAULT '[]',
  excluded     INTEGER NOT NULL DEFAULT 0,           -- 対象外として除外
  collected_at TEXT NOT NULL,
  UNIQUE (source_id, ref, hash)
);
CREATE INDEX idx_pm_act_project ON pm_activities (project_id, occurred_at);

-- 案件の現在の状況
CREATE TABLE pm_project_state (
  project_id     TEXT PRIMARY KEY REFERENCES pm_projects(id),
  phase          TEXT,                               -- preparing / in_progress / review_pending / client_pending / material_pending / permission_pending / stopped / done
  status_text    TEXT,
  stalled_reason TEXT,
  unknowns       TEXT NOT NULL DEFAULT '[]',         -- 未確認事項
  milestones     TEXT NOT NULL DEFAULT '{}',         -- produced / client_approved / published（根拠がある場合のみ）
  evidence       TEXT NOT NULL DEFAULT '[]',
  last_activity_at TEXT,
  human_fields   TEXT NOT NULL DEFAULT '[]',         -- 人が修正した項目（自動更新で上書きしない）
  updated_at     TEXT NOT NULL
);

-- 確定したタスク
CREATE TABLE pm_tasks (
  id               TEXT PRIMARY KEY,                 -- T-xxxxxxxx
  project_id       TEXT NOT NULL REFERENCES pm_projects(id),
  title            TEXT NOT NULL,
  fingerprint      TEXT NOT NULL,                    -- 重複防止
  status           TEXT NOT NULL DEFAULT 'open',     -- open / in_progress / waiting / done / cancelled / on_hold
  assignee         TEXT,
  due              TEXT,                             -- YYYY-MM-DD（根拠がある場合のみ）
  waiting_on       TEXT,                             -- client / material / permission / internal
  waiting_detail   TEXT,
  completion_basis TEXT,                             -- explicit_record / tool_state / human
  origin           TEXT NOT NULL DEFAULT 'ai_extracted', -- ai_extracted / manual / adopted_suggestion
  evidence         TEXT NOT NULL DEFAULT '[]',
  human_edited     INTEGER NOT NULL DEFAULT 0,
  human_fields     TEXT NOT NULL DEFAULT '[]',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  done_at          TEXT
);
CREATE INDEX idx_pm_tasks_project ON pm_tasks (project_id, status);
CREATE INDEX idx_pm_tasks_fp ON pm_tasks (project_id, fingerprint);

-- 決定事項
CREATE TABLE pm_decisions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL REFERENCES pm_projects(id),
  text        TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  decided_at  TEXT,
  evidence    TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL,
  UNIQUE (project_id, fingerprint)
);

-- AIによる提案（確定タスクとは別。人が採用するまでタスクにならない）
CREATE TABLE pm_suggestions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       TEXT NOT NULL REFERENCES pm_projects(id),
  text             TEXT NOT NULL,
  rationale        TEXT,
  fingerprint      TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'proposed', -- proposed / adopted / held / rejected
  adopted_task_id  TEXT,
  evidence         TEXT NOT NULL DEFAULT '[]',
  created_at       TEXT NOT NULL,
  resolved_at      TEXT,
  UNIQUE (project_id, fingerprint)
);

-- 確認が必要な事項（同じ不明点は再度作らない）
CREATE TABLE pm_review_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL,                         -- conflict / completion_unclear / unassigned_activity / multi_project / state_conflict / question
  project_id  TEXT,
  question    TEXT NOT NULL,
  options     TEXT NOT NULL DEFAULT '[]',            -- [{value,label}]
  context     TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'open',          -- open / answered / dismissed
  answer      TEXT,
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);

-- 案件を特定できなかった情報から抽出した項目（紐づけが決まったら反映する）
CREATE TABLE pm_held_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id    TEXT NOT NULL,
  activity_ref TEXT NOT NULL,
  item         TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

-- 更新履歴
CREATE TABLE pm_change_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT NOT NULL,
  actor     TEXT NOT NULL,                           -- system / human
  entity    TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action    TEXT NOT NULL,
  before    TEXT,
  after     TEXT,
  reason    TEXT
);
CREATE INDEX idx_pm_log_entity ON pm_change_log (entity, entity_id);

-- 取得結果の受け取り口（AI処理側が書き込み、Workerが反映する）
CREATE TABLE pm_batches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',       -- pending / applied / failed
  payload     TEXT NOT NULL,
  result      TEXT,
  applied_at  TEXT
);

-- 設定（収集対象・保存期間・AIへ送る範囲・自分の名前 など）
CREATE TABLE pm_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT    NOT NULL,              -- YYYY-MM-DD (日本時間)
  title      TEXT    NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  done_at    TEXT
);
CREATE INDEX idx_tasks_date ON tasks (date, position);

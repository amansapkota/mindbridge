import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(dir, "data");
fs.mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, "mindbridge.db"));
db.exec("PRAGMA foreign_keys = ON");

/**
 * Schema is PRD section 7, unchanged. SQLite has no array type, so the fields
 * the PRD writes as `x[]` (tags, insights, spikes, actionable_insights) are
 * stored as JSON text and parsed at the boundary — see rowToReport below.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS doctors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doctor_id INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  age INTEGER NOT NULL,
  username TEXT NOT NULL UNIQUE,
  description TEXT,
  health_score INTEGER NOT NULL,
  has_partner INTEGER NOT NULL DEFAULT 0,
  compliance_score INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS partners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS simulated_data_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  sleep_hours REAL,
  sleep_quality INTEGER,
  resting_hr INTEGER,
  hrv INTEGER,
  breathing_rate REAL,
  mood_score INTEGER,
  anxiety_score INTEGER,
  energy_score INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sdp_patient_date ON simulated_data_points(patient_id, date);

CREATE TABLE IF NOT EXISTS mood_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  author TEXT NOT NULL CHECK (author IN ('patient','partner')),
  date TEXT NOT NULL,
  mood_rating INTEGER NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_mood_patient_date ON mood_logs(patient_id, date);

CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  author TEXT NOT NULL CHECK (author IN ('patient','partner')),
  date TEXT NOT NULL,
  snippet_id INTEGER,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_journal_patient_date ON journal_entries(patient_id, date);

CREATE TABLE IF NOT EXISTS journal_snippet_pool (
  id INTEGER PRIMARY KEY,
  severity_bucket TEXT NOT NULL,
  theme TEXT NOT NULL,
  perspective TEXT NOT NULL CHECK (perspective IN ('patient','partner')),
  text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  summary_text TEXT NOT NULL,
  insights TEXT NOT NULL DEFAULT '[]',
  spikes TEXT NOT NULL DEFAULT '[]',
  actionable_insights TEXT NOT NULL DEFAULT '[]',
  chart_data TEXT NOT NULL DEFAULT '{}',
  model_used TEXT NOT NULL,
  guardrail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_reports_patient ON reports(patient_id, generated_at);

CREATE TABLE IF NOT EXISTS one_page_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL UNIQUE REFERENCES reports(id) ON DELETE CASCADE,
  content TEXT NOT NULL
);
`);

/**
 * Idempotent column additions for databases created before a change. SQLite has
 * no ADD COLUMN IF NOT EXISTS, so check pragma table_info first.
 */
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`  + ${table}.${column}`);
}

// Patient login (added after the original PRD scope, which had no patient app).
// The PRD's `role` reservation lives on `doctors`/`patients` being separate
// tables; a patient's credentials hang off their existing unique username.
ensureColumn("patients", "password_hash", "TEXT");
ensureColumn("patients", "must_change_password", "INTEGER NOT NULL DEFAULT 1");
ensureColumn("patients", "last_login_at", "TEXT");

// Provenance, so imported rows are distinguishable from generated ones and a
// bad import can be undone.
ensureColumn("simulated_data_points", "source", "TEXT NOT NULL DEFAULT 'generated'");
ensureColumn("mood_logs", "source", "TEXT NOT NULL DEFAULT 'generated'");
ensureColumn("journal_entries", "source", "TEXT NOT NULL DEFAULT 'generated'");
ensureColumn("simulated_data_points", "import_batch_id", "INTEGER");
ensureColumn("mood_logs", "import_batch_id", "INTEGER");
ensureColumn("journal_entries", "import_batch_id", "INTEGER");

db.exec(`
CREATE TABLE IF NOT EXISTS import_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doctor_id INTEGER NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
  filename TEXT,
  status TEXT NOT NULL DEFAULT 'committed',
  patients_created INTEGER NOT NULL DEFAULT 0,
  patients_matched INTEGER NOT NULL DEFAULT 0,
  records_imported INTEGER NOT NULL DEFAULT 0,
  records_skipped INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_import_doctor ON import_batches(doctor_id, created_at);
`);

/** The snippet pool is authored content, not user data — reload it on boot. */
export function loadSnippetPool(snippets) {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM journal_snippet_pool").get().n;
  if (existing === snippets.length) return;

  db.exec("DELETE FROM journal_snippet_pool");
  const insert = db.prepare(
    "INSERT INTO journal_snippet_pool (id, severity_bucket, theme, perspective, text) VALUES (?, ?, ?, ?, ?)"
  );
  for (const s of snippets) {
    insert.run(s.id, s.severity_bucket, s.theme, s.perspective, s.text);
  }
}

/**
 * Prototype scope: a single hardcoded doctor. Section 6.1 auth is bolted on last
 * and reuses this row rather than replacing it.
 */
export function ensureDefaultDoctor() {
  const row = db.prepare("SELECT * FROM doctors WHERE username = ?").get("drsmith");
  if (row) return row;
  db.prepare("INSERT INTO doctors (name, email, username, password_hash) VALUES (?, ?, ?, ?)").run(
    "Dr. Alex Smith",
    "alex.smith@mindbridge.test",
    "drsmith",
    "" // set by auth.js on first boot
  );
  return db.prepare("SELECT * FROM doctors WHERE username = ?").get("drsmith");
}

export const parseJson = (value, fallback) => {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

export function rowToReport(row) {
  if (!row) return null;
  return {
    id: row.id,
    patient_id: row.patient_id,
    generated_at: row.generated_at,
    summary_text: row.summary_text,
    insights: parseJson(row.insights, []),
    spikes: parseJson(row.spikes, []),
    actionable_insights: parseJson(row.actionable_insights, []),
    chart_data: parseJson(row.chart_data, {}),
    model_used: row.model_used,
    guardrail: parseJson(row.guardrail, {}),
  };
}

import "./env.js";
import mysql from "mysql2/promise";

/**
 * Storage is MySQL 8 (mysql2), replacing the original node:sqlite file.
 *
 * The schema below is still PRD section 7. MySQL has no array type either, so
 * the fields the PRD writes as `x[]` (tags, insights, spikes,
 * actionable_insights) are stored as JSON *text* — deliberately TEXT and not
 * MySQL's JSON type, because mysql2 would then hand back parsed objects and
 * `parseJson` at the boundary would have nothing to do. Keeping them text means
 * the read path is identical to what it was on SQLite.
 *
 * Two decisions worth knowing:
 *
 * 1. Every table is prefixed (MINDBRIDGE_TABLE_PREFIX, default `mb_`). The
 *    database this points at is shared with another application whose tables
 *    include `doctors`, `patients`, `journal_entries` and `import_batches` —
 *    same names, entirely different columns. The prefix is what stops the two
 *    from colliding, so it is applied centrally here rather than being written
 *    into every query.
 *
 * 2. `dateStrings: true`. SQLite handed back dates as the text it stored;
 *    mysql2 by default constructs JS Date objects, which would change what the
 *    API returns and break the client's `created_at.replace(" ", "T") + "Z"`
 *    parsing. With dateStrings, DATE yields "YYYY-MM-DD" and DATETIME yields
 *    "YYYY-MM-DD HH:MM:SS" — byte-identical to the old behaviour. Timestamp
 *    defaults are UTC_TIMESTAMP() rather than CURRENT_TIMESTAMP so they stay UTC
 *    regardless of the server's session time zone, which is what the client
 *    assumes when it appends the "Z".
 */

const required = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Copy server/.env.example to server/.env and fill in the database credentials.`
    );
  }
  return value;
};

export const TABLE_PREFIX = process.env.MINDBRIDGE_TABLE_PREFIX ?? "mb_";

const pool = mysql.createPool({
  host: required("MINDBRIDGE_DB_HOST"),
  port: Number(process.env.MINDBRIDGE_DB_PORT || 3306),
  user: required("MINDBRIDGE_DB_USER"),
  password: process.env.MINDBRIDGE_DB_PASSWORD || "",
  database: required("MINDBRIDGE_DB_NAME"),
  waitForConnections: true,
  connectionLimit: Number(process.env.MINDBRIDGE_DB_POOL || 10),
  connectTimeout: 20000,
  dateStrings: true,
  // The database is remote, so idle sockets are worth keeping warm rather than
  // paying a fresh TCP + auth handshake on the next request.
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
});

/* ------------------------------------------------------------------ *
 * Table prefixing
 * ------------------------------------------------------------------ */
const TABLES = [
  "doctors",
  "patients",
  "partners",
  "simulated_data_points",
  "mood_logs",
  "journal_entries",
  "journal_snippet_pool",
  "reports",
  "one_page_summaries",
  "import_batches",
];

/** Qualify one table name — for the few places that build SQL from a list. */
export const table = (name) => `${TABLE_PREFIX}${name}`;

// Word-boundary anchored, so `patient_id` and `import_batch_id` are left alone
// while `patients` and `import_batches` are rewritten.
const TABLE_RE = new RegExp(`\\b(${TABLES.join("|")})\\b`, "g");
const qualify = (sql) => (TABLE_PREFIX ? sql.replace(TABLE_RE, (m) => TABLE_PREFIX + m) : sql);

/* ------------------------------------------------------------------ *
 * Statement API
 *
 * Mirrors the shape node:sqlite offered — prepare().get/.all/.run — so call
 * sites read the same as before. The difference the callers do have to care
 * about is that all three are now async: MySQL is a network round trip and
 * there is no synchronous equivalent to fake.
 * ------------------------------------------------------------------ */

// mysql2 rejects `undefined` parameters; SQLite treated a missing value as
// NULL, and several call sites still pass `x ?? null` style optionals.
const bind = (args) => args.map((a) => (a === undefined ? null : a));

function makeHandle(runner) {
  return {
    prepare(sql) {
      const text = qualify(sql);
      const exec = async (args) => {
        const [rows] = await runner.execute(text, bind(args));
        return rows;
      };
      return {
        async get(...args) {
          const rows = await exec(args);
          return rows[0] ?? undefined;
        },
        async all(...args) {
          return await exec(args);
        },
        async run(...args) {
          const result = await exec(args);
          return { lastInsertRowid: result.insertId, changes: result.affectedRows };
        },
      };
    },

    /**
     * Multi-row INSERT in a single round trip. Generating a patient writes ~30
     * data points plus mood logs and journals; against a remote server that is
     * the difference between one request and a hundred sequential ones.
     * Uses query() rather than execute() because the nested-array `VALUES ?`
     * expansion is a client-side feature of the text protocol.
     */
    async insertMany(sql, rows) {
      if (!rows.length) return { changes: 0 };
      const [result] = await runner.query(qualify(sql), [rows.map(bind)]);
      return { lastInsertRowid: result.insertId, changes: result.affectedRows };
    },

    async exec(sql) {
      await runner.query(qualify(sql));
    },
  };
}

export const db = makeHandle(pool);

/**
 * Runs `fn` against a single pooled connection with a transaction open around
 * it. This has to be explicit now: on SQLite `db.exec("BEGIN")` applied to the
 * one and only connection, but a pool hands out a different connection per
 * statement, so BEGIN and COMMIT would land on unrelated sessions.
 */
export async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(makeHandle(conn));
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

export const closePool = () => pool.end();

/* ------------------------------------------------------------------ *
 * Schema — PRD section 7
 * ------------------------------------------------------------------ */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS doctors (
     id INT AUTO_INCREMENT PRIMARY KEY,
     name VARCHAR(150) NOT NULL,
     email VARCHAR(191) NOT NULL,
     username VARCHAR(60) NOT NULL UNIQUE,
     password_hash VARCHAR(255) NOT NULL
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS patients (
     id INT AUTO_INCREMENT PRIMARY KEY,
     doctor_id INT NOT NULL,
     name VARCHAR(150) NOT NULL,
     email VARCHAR(191) NOT NULL,
     age INT NOT NULL,
     username VARCHAR(60) NOT NULL UNIQUE,
     description TEXT,
     health_score INT NOT NULL,
     has_partner TINYINT NOT NULL DEFAULT 0,
     compliance_score INT,
     created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
     KEY idx_patients_doctor (doctor_id),
     FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS partners (
     id INT AUTO_INCREMENT PRIMARY KEY,
     patient_id INT NOT NULL,
     name VARCHAR(150) NOT NULL,
     KEY idx_partners_patient (patient_id),
     FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS simulated_data_points (
     id INT AUTO_INCREMENT PRIMARY KEY,
     patient_id INT NOT NULL,
     date DATE NOT NULL,
     sleep_hours DOUBLE,
     sleep_quality INT,
     resting_hr INT,
     hrv INT,
     breathing_rate DOUBLE,
     mood_score INT,
     anxiety_score INT,
     energy_score INT,
     KEY idx_sdp_patient_date (patient_id, date),
     FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS mood_logs (
     id INT AUTO_INCREMENT PRIMARY KEY,
     patient_id INT NOT NULL,
     author VARCHAR(20) NOT NULL,
     date DATE NOT NULL,
     mood_rating INT NOT NULL,
     tags TEXT NOT NULL DEFAULT ('[]'),
     KEY idx_mood_patient_date (patient_id, date),
     CONSTRAINT chk_mood_author CHECK (author IN ('patient','partner')),
     FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS journal_entries (
     id INT AUTO_INCREMENT PRIMARY KEY,
     patient_id INT NOT NULL,
     author VARCHAR(20) NOT NULL,
     date DATE NOT NULL,
     snippet_id INT,
     text TEXT NOT NULL,
     KEY idx_journal_patient_date (patient_id, date),
     CONSTRAINT chk_journal_author CHECK (author IN ('patient','partner')),
     FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS journal_snippet_pool (
     id INT PRIMARY KEY,
     severity_bucket VARCHAR(40) NOT NULL,
     theme VARCHAR(60) NOT NULL,
     perspective VARCHAR(20) NOT NULL,
     text TEXT NOT NULL,
     CONSTRAINT chk_snippet_perspective CHECK (perspective IN ('patient','partner'))
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS reports (
     id INT AUTO_INCREMENT PRIMARY KEY,
     patient_id INT NOT NULL,
     generated_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
     summary_text TEXT NOT NULL,
     insights LONGTEXT NOT NULL DEFAULT ('[]'),
     spikes LONGTEXT NOT NULL DEFAULT ('[]'),
     actionable_insights LONGTEXT NOT NULL DEFAULT ('[]'),
     chart_data LONGTEXT NOT NULL DEFAULT ('{}'),
     model_used VARCHAR(191) NOT NULL,
     guardrail TEXT NOT NULL DEFAULT ('{}'),
     KEY idx_reports_patient (patient_id, generated_at),
     FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS one_page_summaries (
     id INT AUTO_INCREMENT PRIMARY KEY,
     report_id INT NOT NULL UNIQUE,
     content LONGTEXT NOT NULL,
     FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS import_batches (
     id INT AUTO_INCREMENT PRIMARY KEY,
     doctor_id INT NOT NULL,
     filename VARCHAR(255),
     status VARCHAR(20) NOT NULL DEFAULT 'committed',
     patients_created INT NOT NULL DEFAULT 0,
     patients_matched INT NOT NULL DEFAULT 0,
     records_imported INT NOT NULL DEFAULT 0,
     records_skipped INT NOT NULL DEFAULT 0,
     summary TEXT NOT NULL DEFAULT ('{}'),
     created_at DATETIME NOT NULL DEFAULT (UTC_TIMESTAMP()),
     KEY idx_import_doctor (doctor_id, created_at),
     FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

/**
 * Idempotent column additions for databases created before a change — the
 * MySQL equivalent of the old pragma table_info check. MySQL has no
 * ADD COLUMN IF NOT EXISTS either, so ask information_schema first.
 */
async function ensureColumn(name, column, definition) {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table(name), column]
  );
  if (rows.length) return;
  await pool.query(`ALTER TABLE \`${table(name)}\` ADD COLUMN \`${column}\` ${definition}`);
  console.log(`  + ${table(name)}.${column}`);
}

let migrated = false;

/** Idempotent; every entry point awaits this before touching the database. */
export async function migrate() {
  if (migrated) return;

  for (const statement of SCHEMA) await pool.query(qualify(statement));

  // Patient login (added after the original PRD scope, which had no patient
  // app). The PRD's `role` reservation lives on doctors/patients being separate
  // tables; a patient's credentials hang off their existing unique username.
  await ensureColumn("patients", "password_hash", "VARCHAR(255)");
  await ensureColumn("patients", "must_change_password", "TINYINT NOT NULL DEFAULT 1");
  await ensureColumn("patients", "last_login_at", "DATETIME");

  // Provenance, so imported rows are distinguishable from generated ones and a
  // bad import can be undone.
  await ensureColumn("simulated_data_points", "source", "VARCHAR(20) NOT NULL DEFAULT 'generated'");
  await ensureColumn("mood_logs", "source", "VARCHAR(20) NOT NULL DEFAULT 'generated'");
  await ensureColumn("journal_entries", "source", "VARCHAR(20) NOT NULL DEFAULT 'generated'");
  await ensureColumn("simulated_data_points", "import_batch_id", "INT");
  await ensureColumn("mood_logs", "import_batch_id", "INT");
  await ensureColumn("journal_entries", "import_batch_id", "INT");

  migrated = true;
}

/** The snippet pool is authored content, not user data — reload it on boot. */
export async function loadSnippetPool(snippets) {
  const { n } = await db.prepare("SELECT COUNT(*) AS n FROM journal_snippet_pool").get();
  if (n === snippets.length) return;

  await db.exec("DELETE FROM journal_snippet_pool");
  await db.insertMany(
    "INSERT INTO journal_snippet_pool (id, severity_bucket, theme, perspective, text) VALUES ?",
    snippets.map((s) => [s.id, s.severity_bucket, s.theme, s.perspective, s.text])
  );
}

/**
 * Prototype scope: a single hardcoded doctor. Section 6.1 auth is bolted on last
 * and reuses this row rather than replacing it.
 */
export async function ensureDefaultDoctor() {
  const row = await db.prepare("SELECT * FROM doctors WHERE username = ?").get("drsmith");
  if (row) return row;
  await db.prepare("INSERT INTO doctors (name, email, username, password_hash) VALUES (?, ?, ?, ?)").run(
    "Dr. Alex Smith",
    "alex.smith@mindbridge.test",
    "drsmith",
    "" // set by auth.js on first boot
  );
  return await db.prepare("SELECT * FROM doctors WHERE username = ?").get("drsmith");
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

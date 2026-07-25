import { db } from "./db.js";
import { computeCompliance } from "./generator.js";
import { setPatientPassword } from "./auth.js";

/**
 * JSON import (`mindbridge.v1`).
 *
 * Lets a doctor load real or externally-produced data for a patient instead of
 * relying on the simulated generator. Deliberately forgiving at the edges —
 * files come from other systems and spreadsheet exports, so one malformed row is
 * reported and skipped rather than rejecting the whole file.
 *
 * Two phases: `analyzeImport` is a dry run that resolves patients and reports
 * problems; `commitImport` re-runs it and writes inside a transaction.
 */

const SECTIONS = ["dataPoints", "moodLogs", "journals"];

/* ------------------------------------------------------------------ *
 * Small validators — hand-rolled to keep the prototype dependency-free
 * ------------------------------------------------------------------ */
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Accepts "YYYY-MM-DD", full ISO, or epoch ms; returns "YYYY-MM-DD". */
function toDate(value) {
  if (value === undefined || value === null || value === "") return null;
  const d = typeof value === "number" ? new Date(value) : new Date(String(value).slice(0, 10));
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Numbers often arrive as strings from CSV conversions. */
function toNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) ? n : NaN;
}

function numberField(row, key, { min, max, integer = false, issues, path }) {
  const raw = row[key];
  if (raw === undefined || raw === null || raw === "") return null;

  const n = toNumber(raw);
  if (Number.isNaN(n)) {
    issues.push({ path: `${path}.${key}`, message: `“${raw}” is not a number` });
    return undefined; // undefined = invalid, null = absent
  }
  if (n < min || n > max) {
    issues.push({ path: `${path}.${key}`, message: `${n} is outside the allowed range ${min}–${max}` });
    return undefined;
  }
  return integer ? Math.round(n) : n;
}

const METRIC_RULES = {
  sleep_hours: { min: 0, max: 24 },
  sleep_quality: { min: 0, max: 100, integer: true },
  resting_hr: { min: 20, max: 220, integer: true },
  hrv: { min: 0, max: 300, integer: true },
  breathing_rate: { min: 2, max: 60 },
  mood_score: { min: 1, max: 10, integer: true },
  anxiety_score: { min: 1, max: 10, integer: true },
  energy_score: { min: 1, max: 10, integer: true },
};

function parseDataPoint(row, path, issues) {
  if (!isObject(row)) {
    issues.push({ path, message: "Expected an object" });
    return null;
  }

  const date = toDate(row.date);
  if (!date) {
    issues.push({ path: `${path}.date`, message: `Missing or unrecognised date: ${JSON.stringify(row.date)}` });
    return null;
  }

  const out = { date };
  let invalid = false;
  let hasValue = false;

  for (const [key, rule] of Object.entries(METRIC_RULES)) {
    const value = numberField(row, key, { ...rule, issues, path });
    if (value === undefined) invalid = true;
    else {
      out[key] = value;
      if (value !== null) hasValue = true;
    }
  }

  if (invalid) return null;
  if (!hasValue) {
    issues.push({ path, message: "Row has a date but no measurements" });
    return null;
  }
  return out;
}

function parseAuthor(row, path, issues) {
  const author = row.author === undefined || row.author === null ? "patient" : String(row.author).toLowerCase();
  if (author !== "patient" && author !== "partner") {
    issues.push({ path: `${path}.author`, message: `Must be "patient" or "partner", got “${row.author}”` });
    return null;
  }
  return author;
}

function parseMoodLog(row, path, issues) {
  if (!isObject(row)) {
    issues.push({ path, message: "Expected an object" });
    return null;
  }

  const date = toDate(row.date);
  if (!date) {
    issues.push({ path: `${path}.date`, message: `Missing or unrecognised date: ${JSON.stringify(row.date)}` });
    return null;
  }

  const author = parseAuthor(row, path, issues);
  if (!author) return null;

  const rating = numberField(row, "mood_rating", { min: 1, max: 10, integer: true, issues, path });
  if (rating === undefined) return null;
  if (rating === null) {
    issues.push({ path: `${path}.mood_rating`, message: "mood_rating is required" });
    return null;
  }

  let tags = [];
  if (row.tags !== undefined && row.tags !== null) {
    if (!Array.isArray(row.tags)) {
      issues.push({ path: `${path}.tags`, message: "tags must be an array of strings" });
      return null;
    }
    tags = row.tags.map((t) => String(t).slice(0, 40)).slice(0, 6);
  }

  return { date, author, mood_rating: rating, tags };
}

function parseJournal(row, path, issues) {
  if (!isObject(row)) {
    issues.push({ path, message: "Expected an object" });
    return null;
  }

  const date = toDate(row.date);
  if (!date) {
    issues.push({ path: `${path}.date`, message: `Missing or unrecognised date: ${JSON.stringify(row.date)}` });
    return null;
  }

  const author = parseAuthor(row, path, issues);
  if (!author) return null;

  const text = row.text === undefined || row.text === null ? "" : String(row.text).trim();
  if (!text) {
    issues.push({ path: `${path}.text`, message: "text is required" });
    return null;
  }
  if (text.length > 5000) {
    issues.push({ path: `${path}.text`, message: `Entry is ${text.length} characters (max 5000)` });
    return null;
  }

  return { date, author, text };
}

function parseDemographics(raw, path, errors) {
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw)) {
    errors.push({ path, message: "demographics must be an object" });
    return null;
  }

  const out = {};
  if (raw.name !== undefined) out.name = String(raw.name).trim().slice(0, 120);
  if (raw.email !== undefined) out.email = String(raw.email).trim().slice(0, 160);
  if (raw.username !== undefined) out.username = String(raw.username).trim().slice(0, 60);
  if (raw.description !== undefined) out.description = String(raw.description).trim().slice(0, 4000);
  if (raw.partner_name !== undefined && raw.partner_name !== null) {
    out.partner_name = String(raw.partner_name).trim().slice(0, 120);
  }

  const issues = [];
  const age = numberField(raw, "age", { min: 1, max: 120, integer: true, issues, path });
  const health = numberField(raw, "health_score", { min: 1, max: 10, integer: true, issues, path });
  errors.push(...issues);
  if (age !== null && age !== undefined) out.age = age;
  if (health !== null && health !== undefined) out.health_score = health;

  return out;
}

/** Accept `{patients:[…]}`, a bare array, or a single bundle. */
function normaliseEnvelope(raw) {
  if (Array.isArray(raw)) return { format: "array", patients: raw };
  if (isObject(raw)) {
    if (Array.isArray(raw.patients)) {
      return { format: typeof raw.format === "string" ? raw.format : "mindbridge.v1", patients: raw.patients };
    }
    return { format: "single-bundle", patients: [raw] };
  }
  const err = new Error("Import file must be a JSON object or array");
  err.status = 400;
  throw err;
}

function resolvePatient(doctorId, match, demographics) {
  const username = match?.username ?? demographics?.username;
  const email = match?.email ?? demographics?.email;

  if (match?.patientId !== undefined) {
    return db.prepare("SELECT * FROM patients WHERE id = ? AND doctor_id = ?").get(Number(match.patientId), doctorId) || null;
  }
  if (username) {
    return db.prepare("SELECT * FROM patients WHERE username = ? AND doctor_id = ?").get(username, doctorId) || null;
  }
  if (email) {
    return db.prepare("SELECT * FROM patients WHERE email = ? AND doctor_id = ?").get(email, doctorId) || null;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Phase 1 — dry run
 * ------------------------------------------------------------------ */
export function analyzeImport(raw, doctor, options = {}) {
  const { createMissingPatients = false } = options;
  const { format, patients } = normaliseEnvelope(raw);

  if (patients.length === 0) {
    const err = new Error("Import file contains no patients");
    err.status = 400;
    throw err;
  }
  if (patients.length > 200) {
    const err = new Error("Import file exceeds 200 patients per upload");
    err.status = 413;
    throw err;
  }

  const bundles = patients.map((rawBundle, index) => {
    const errors = [];
    const warnings = [];
    const path = `patients[${index}]`;

    if (!isObject(rawBundle)) {
      return {
        index,
        label: `Entry ${index + 1}`,
        action: "error",
        patientId: null,
        errors: [{ path, message: "Expected an object" }],
        warnings: [],
        accepted: { dataPoints: 0, moodLogs: 0, journals: 0 },
        rejected: { dataPoints: 0, moodLogs: 0, journals: 0 },
      };
    }

    const demographics = parseDemographics(rawBundle.demographics, `${path}.demographics`, errors);

    const parse = (section, parser) => {
      const rows = rawBundle[section];
      if (rows === undefined || rows === null) return [];
      if (!Array.isArray(rows)) {
        warnings.push({ path: `${path}.${section}`, message: `Expected an array, got ${typeof rows}` });
        return [];
      }
      const out = [];
      rows.forEach((row, i) => {
        const parsed = parser(row, `${path}.${section}[${i}]`, warnings);
        if (parsed) out.push(parsed);
      });
      return out;
    };

    const dataPoints = parse("dataPoints", parseDataPoint);
    const moodLogs = parse("moodLogs", parseMoodLog);
    const journals = parse("journals", parseJournal);

    const rawCount = (section) => (Array.isArray(rawBundle[section]) ? rawBundle[section].length : 0);
    const accepted = { dataPoints: dataPoints.length, moodLogs: moodLogs.length, journals: journals.length };
    const rejected = {
      dataPoints: Math.max(0, rawCount("dataPoints") - dataPoints.length),
      moodLogs: Math.max(0, rawCount("moodLogs") - moodLogs.length),
      journals: Math.max(0, rawCount("journals") - journals.length),
    };

    const existing = errors.length ? null : resolvePatient(doctor.id, rawBundle.match, demographics);

    let action = "error";
    let label = demographics?.name || `Entry ${index + 1}`;

    if (existing) {
      action = "match";
      label = existing.name;
    } else if (errors.length === 0) {
      if (!createMissingPatients) {
        errors.push({
          path,
          message:
            "No matching patient. Turn on “Create missing patients”, or fix the match (username, email or patientId).",
        });
      } else if (!demographics?.name || !demographics?.username) {
        errors.push({
          path: `${path}.demographics`,
          message: "Creating a patient needs at least demographics.name and demographics.username",
        });
      } else if (db.prepare("SELECT id FROM patients WHERE username = ?").get(demographics.username)) {
        errors.push({
          path: `${path}.demographics.username`,
          message: `Username “${demographics.username}” is already taken by another patient`,
        });
      } else {
        action = "create";
      }
    }

    const hasRows = accepted.dataPoints + accepted.moodLogs + accepted.journals > 0;
    if (action !== "error" && !hasRows && !demographics) {
      warnings.push({ path, message: "Nothing to import for this patient" });
    }

    return {
      index,
      label,
      action,
      patientId: existing?.id ?? null,
      errors,
      warnings,
      accepted,
      rejected,
      dateRange: dataPoints.length
        ? { from: dataPoints[0].date, to: dataPoints[dataPoints.length - 1].date }
        : null,
      parsed: { demographics, dataPoints, moodLogs, journals },
    };
  });

  const totals = { patients: bundles.length, toCreate: 0, toMatch: 0, accepted: {}, rejected: {}, errors: 0, warnings: 0 };
  for (const s of SECTIONS) {
    totals.accepted[s] = 0;
    totals.rejected[s] = 0;
  }
  for (const b of bundles) {
    if (b.action === "create") totals.toCreate++;
    if (b.action === "match") totals.toMatch++;
    totals.errors += b.errors.length;
    totals.warnings += b.warnings.length;
    for (const s of SECTIONS) {
      if (b.action !== "error") totals.accepted[s] += b.accepted[s];
      totals.rejected[s] += b.rejected[s];
    }
  }

  return { format, bundles, totals, importable: bundles.some((b) => b.action !== "error") };
}

/** Strip the parsed payload before sending a plan to the browser. */
export const publicPlan = (plan) => ({
  ...plan,
  bundles: plan.bundles.map(({ parsed: _p, ...rest }) => rest),
});

/* ------------------------------------------------------------------ *
 * Phase 2 — commit
 * ------------------------------------------------------------------ */
export function commitImport(raw, doctor, options = {}, filename = null) {
  const plan = analyzeImport(raw, doctor, options);
  if (!plan.importable) {
    const err = new Error("Nothing to import — every entry has blocking errors");
    err.status = 422;
    throw err;
  }

  const result = {
    batchId: null,
    patientsCreated: 0,
    patientsMatched: 0,
    recordsImported: 0,
    recordsSkipped: 0,
    duplicatesSkipped: 0,
    createdCredentials: [],
    perSection: { dataPoints: 0, moodLogs: 0, journals: 0 },
  };

  db.exec("BEGIN");
  try {
    const batchInfo = db
      .prepare("INSERT INTO import_batches (doctor_id, filename, status) VALUES (?, ?, 'committed')")
      .run(doctor.id, filename);
    const batchId = Number(batchInfo.lastInsertRowid);
    result.batchId = batchId;

    for (const bundle of plan.bundles) {
      if (bundle.action === "error") continue;
      const { demographics, dataPoints, moodLogs, journals } = bundle.parsed;

      let patientId = bundle.patientId;

      if (bundle.action === "create") {
        const info = db
          .prepare(
            `INSERT INTO patients (doctor_id, name, email, age, username, description, health_score, has_partner)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            doctor.id,
            demographics.name,
            demographics.email || "",
            demographics.age ?? 0,
            demographics.username,
            demographics.description || null,
            demographics.health_score ?? 5,
            demographics.partner_name ? 1 : 0
          );
        patientId = Number(info.lastInsertRowid);
        result.patientsCreated++;

        if (demographics.partner_name) {
          db.prepare("INSERT INTO partners (patient_id, name) VALUES (?, ?)").run(patientId, demographics.partner_name);
        }

        // Imported patients get a login straight away, same as any other.
        const tempPassword = setPatientPassword(patientId, null, true);
        result.createdCredentials.push({
          patientId,
          name: demographics.name,
          username: demographics.username,
          tempPassword,
        });
      } else {
        result.patientsMatched++;
        if (demographics) {
          const fields = [];
          const params = [];
          for (const key of ["name", "email", "description"]) {
            if (demographics[key] !== undefined) {
              fields.push(`${key} = ?`);
              params.push(demographics[key]);
            }
          }
          for (const key of ["age", "health_score"]) {
            if (demographics[key] !== undefined) {
              fields.push(`${key} = ?`);
              params.push(demographics[key]);
            }
          }
          if (fields.length) {
            params.push(patientId);
            db.prepare(`UPDATE patients SET ${fields.join(", ")} WHERE id = ?`).run(...params);
          }
          if (demographics.partner_name) {
            const existingPartner = db.prepare("SELECT id FROM partners WHERE patient_id = ?").get(patientId);
            if (existingPartner) {
              db.prepare("UPDATE partners SET name = ? WHERE id = ?").run(demographics.partner_name, existingPartner.id);
            } else {
              db.prepare("INSERT INTO partners (patient_id, name) VALUES (?, ?)").run(patientId, demographics.partner_name);
            }
            db.prepare("UPDATE patients SET has_partner = 1 WHERE id = ?").run(patientId);
          }
        }
      }

      // Re-importing the same day replaces it rather than stacking duplicates,
      // so a corrected file can simply be uploaded again.
      const delPoint = db.prepare("DELETE FROM simulated_data_points WHERE patient_id = ? AND date = ?");
      const insPoint = db.prepare(`
        INSERT INTO simulated_data_points
          (patient_id, date, sleep_hours, sleep_quality, resting_hr, hrv, breathing_rate,
           mood_score, anxiety_score, energy_score, source, import_batch_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'imported', ?)`);

      for (const p of dataPoints) {
        delPoint.run(patientId, p.date);
        insPoint.run(
          patientId, p.date,
          p.sleep_hours ?? null, p.sleep_quality ?? null, p.resting_hr ?? null, p.hrv ?? null,
          p.breathing_rate ?? null, p.mood_score ?? null, p.anxiety_score ?? null, p.energy_score ?? null,
          batchId
        );
        result.perSection.dataPoints++;
      }

      const delMood = db.prepare("DELETE FROM mood_logs WHERE patient_id = ? AND author = ? AND date = ?");
      const insMood = db.prepare(
        "INSERT INTO mood_logs (patient_id, author, date, mood_rating, tags, source, import_batch_id) VALUES (?, ?, ?, ?, ?, 'imported', ?)"
      );
      for (const m of moodLogs) {
        delMood.run(patientId, m.author, m.date);
        insMood.run(patientId, m.author, m.date, m.mood_rating, JSON.stringify(m.tags), batchId);
        result.perSection.moodLogs++;
      }

      // Journals have no natural key — a patient may legitimately write twice in
      // one day — so instead of replacing by date, skip rows that are byte-for-byte
      // identical. Distinct same-day entries still import; re-uploading the same
      // file doesn't stack copies.
      const findJournal = db.prepare(
        "SELECT id FROM journal_entries WHERE patient_id = ? AND author = ? AND date = ? AND text = ? LIMIT 1"
      );
      const insJournal = db.prepare(
        "INSERT INTO journal_entries (patient_id, author, date, snippet_id, text, source, import_batch_id) VALUES (?, ?, ?, NULL, ?, 'imported', ?)"
      );
      for (const j of journals) {
        if (findJournal.get(patientId, j.author, j.date, j.text)) {
          result.duplicatesSkipped++;
          continue;
        }
        insJournal.run(patientId, j.author, j.date, j.text, batchId);
        result.perSection.journals++;
      }

      // Compliance is derived from coverage, so it has to be recalculated.
      const points = db.prepare("SELECT date FROM simulated_data_points WHERE patient_id = ? ORDER BY date").all(patientId);
      const patientMoods = db
        .prepare("SELECT date FROM mood_logs WHERE patient_id = ? AND author = 'patient'")
        .all(patientId);
      if (points.length) {
        const compliance = computeCompliance(points, patientMoods);
        db.prepare("UPDATE patients SET compliance_score = ? WHERE id = ?").run(compliance.score, patientId);
      }
    }

    result.recordsImported = SECTIONS.reduce((n, s) => n + result.perSection[s], 0);
    result.recordsSkipped = SECTIONS.reduce((n, s) => n + plan.totals.rejected[s], 0);

    db.prepare(
      `UPDATE import_batches SET patients_created = ?, patients_matched = ?, records_imported = ?,
              records_skipped = ?, summary = ? WHERE id = ?`
    ).run(
      result.patientsCreated,
      result.patientsMatched,
      result.recordsImported,
      result.recordsSkipped,
      JSON.stringify({ perSection: result.perSection, rejected: plan.totals.rejected }),
      batchId
    );

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return { ...result, plan: publicPlan(plan) };
}

/** Remove everything a batch wrote. Patients it created are left in place. */
export function revertImport(batchId, doctor) {
  const batch = db.prepare("SELECT * FROM import_batches WHERE id = ? AND doctor_id = ?").get(batchId, doctor.id);
  if (!batch) {
    const err = new Error("Import batch not found");
    err.status = 404;
    throw err;
  }
  if (batch.status === "reverted") {
    const err = new Error("This import has already been reverted");
    err.status = 409;
    throw err;
  }

  db.exec("BEGIN");
  try {
    let deleted = 0;
    for (const table of ["simulated_data_points", "mood_logs", "journal_entries"]) {
      const info = db.prepare(`DELETE FROM ${table} WHERE import_batch_id = ?`).run(batchId);
      deleted += Number(info.changes);
    }
    db.prepare("UPDATE import_batches SET status = 'reverted' WHERE id = ?").run(batchId);
    db.exec("COMMIT");
    return { deleted };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** A valid, fully-populated example doctors can download as a starting point. */
export const IMPORT_TEMPLATE = {
  format: "mindbridge.v1",
  patients: [
    {
      // Match an existing patient. username, email or patientId — any one works.
      match: { username: "danielo" },
      demographics: {
        name: "Daniel Okafor",
        email: "daniel.o@example.com",
        age: 34,
        description: "Referred after relationship breakdown. Seen monthly.",
        health_score: 3,
        partner_name: "Rachel",
      },
      dataPoints: [
        {
          date: "2026-07-20",
          sleep_hours: 5.2,
          sleep_quality: 44,
          resting_hr: 78,
          hrv: 31,
          breathing_rate: 17.2,
          mood_score: 3,
          anxiety_score: 7,
          energy_score: 3,
        },
        {
          date: "2026-07-21",
          sleep_hours: 4.1,
          sleep_quality: 30,
          resting_hr: 84,
          hrv: 26,
          breathing_rate: 18.4,
          mood_score: 2,
          anxiety_score: 9,
          energy_score: 2,
        },
      ],
      moodLogs: [
        { date: "2026-07-20", author: "patient", mood_rating: 3, tags: ["low", "tired"] },
        { date: "2026-07-21", author: "patient", mood_rating: 2, tags: ["anxious"] },
        { date: "2026-07-21", author: "partner", mood_rating: 4, tags: ["withdrawn"] },
      ],
      journals: [
        {
          date: "2026-07-21",
          author: "patient",
          text: "Barely slept. Sat in the car outside work for twenty minutes before I could go in.",
        },
        {
          date: "2026-07-21",
          author: "partner",
          text: "He's gone very quiet again. Says he's fine. He isn't.",
        },
      ],
    },
    {
      // A patient who does not exist yet — needs "Create missing patients",
      // plus demographics.name and demographics.username.
      demographics: {
        name: "Sita Sharma",
        username: "sitas",
        email: "sita.s@example.com",
        age: 28,
        health_score: 6,
        description: "New referral — panic symptoms, first assessment pending.",
      },
      dataPoints: [
        {
          date: "2026-07-21",
          sleep_hours: 6.8,
          sleep_quality: 64,
          resting_hr: 70,
          hrv: 44,
          breathing_rate: 15.1,
          mood_score: 6,
          anxiety_score: 5,
          energy_score: 6,
        },
      ],
      moodLogs: [{ date: "2026-07-21", author: "patient", mood_rating: 6, tags: ["ok"] }],
      journals: [],
    },
  ],
};

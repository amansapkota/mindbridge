import express from "express";
import cors from "cors";
import {
  db,
  withTransaction,
  migrate,
  loadSnippetPool,
  ensureDefaultDoctor,
  rowToReport,
  parseJson,
} from "./db.js";
import { SNIPPETS, generateDataset, computeCompliance, bucketForScore, SEVERITY_BANDS } from "./generator.js";
import { generateReport, runGuardrail, aiConfigured, aiDescription } from "./ai.js";
import { buildOnePager } from "./onePager.js";
import { attachAuth, requireDoctor, requirePatient, requireAnyone, setPatientPassword } from "./auth.js";
import { analyzeImport, commitImport, publicPlan, revertImport, IMPORT_TEMPLATE } from "./import.js";

await migrate();
await loadSnippetPool(SNIPPETS);
const DOCTOR = await ensureDefaultDoctor();

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "8mb" }));

await attachAuth(app);

const TRACKED_DAYS = 30;
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ------------------------------------------------------------------ *
 * Dataset persistence
 *
 * Only reached from "Regenerate data" now — creating a patient no longer
 * fabricates a history for them. Replaces the patient's whole window, so the
 * generated rows never interleave with real self-reported or imported ones.
 *
 * One transaction and three multi-row inserts. The database is remote now, so
 * the old row-at-a-time loop would be ~100 sequential round trips per patient.
 * ------------------------------------------------------------------ */
async function persistDataset(patientId, dataset) {
  await withTransaction(async (tx) => {
    await tx.prepare("DELETE FROM simulated_data_points WHERE patient_id = ?").run(patientId);
    await tx.prepare("DELETE FROM mood_logs WHERE patient_id = ?").run(patientId);
    await tx.prepare("DELETE FROM journal_entries WHERE patient_id = ?").run(patientId);

    await tx.insertMany(
      `INSERT INTO simulated_data_points
         (patient_id, date, sleep_hours, sleep_quality, resting_hr, hrv, breathing_rate,
          mood_score, anxiety_score, energy_score, source)
       VALUES ?`,
      dataset.points.map((p) => [
        patientId, p.date, p.sleep_hours, p.sleep_quality, p.resting_hr, p.hrv,
        p.breathing_rate, p.mood_score, p.anxiety_score, p.energy_score, "generated",
      ])
    );

    const moods = dataset.patient.moodLogs.map((m) => [patientId, "patient", m.date, m.mood_rating, JSON.stringify(m.tags), "generated"]);
    const journals = dataset.patient.journals.map((j) => [patientId, "patient", j.date, j.snippet_id, j.text, "generated"]);

    if (dataset.partner) {
      for (const m of dataset.partner.moodLogs) {
        moods.push([patientId, "partner", m.date, m.mood_rating, JSON.stringify(m.tags), "generated"]);
      }
      for (const j of dataset.partner.journals) {
        journals.push([patientId, "partner", j.date, j.snippet_id, j.text, "generated"]);
      }
    }

    await tx.insertMany(
      "INSERT INTO mood_logs (patient_id, author, date, mood_rating, tags, source) VALUES ?",
      moods
    );
    await tx.insertMany(
      "INSERT INTO journal_entries (patient_id, author, date, snippet_id, text, source) VALUES ?",
      journals
    );

    await tx.prepare("UPDATE patients SET compliance_score = ? WHERE id = ?").run(dataset.compliance.score, patientId);
  });
}

/** Everything the dashboard and the AI prompt need, read back from the DB. */
async function loadPatientData(patientId) {
  const patient = await db.prepare("SELECT * FROM patients WHERE id = ?").get(patientId);
  if (!patient) return null;

  const [partner, points, moods, journals] = await Promise.all([
    db.prepare("SELECT * FROM partners WHERE patient_id = ?").get(patientId),
    db.prepare("SELECT * FROM simulated_data_points WHERE patient_id = ? ORDER BY date ASC").all(patientId),
    db.prepare("SELECT * FROM mood_logs WHERE patient_id = ? ORDER BY date ASC").all(patientId),
    db.prepare("SELECT * FROM journal_entries WHERE patient_id = ? ORDER BY date ASC").all(patientId),
  ]);

  const shapeMood = (m) => ({ date: m.date, mood_rating: m.mood_rating, tags: parseJson(m.tags, []) });

  const moodLogs = moods.filter((m) => m.author === "patient").map(shapeMood);
  const partnerMoodLogs = moods.filter((m) => m.author === "partner").map(shapeMood);

  return {
    patient,
    partner: partner || null,
    points,
    moodLogs,
    journals: journals.filter((j) => j.author === "patient"),
    partnerMoodLogs,
    partnerJournals: journals.filter((j) => j.author === "partner"),
    compliance: computeCompliance(points, moodLogs),
  };
}

/** Credential state for the doctor's view — never the hash itself. */
const credentialsFor = (patient) => ({
  username: patient.username,
  hasPassword: Boolean(patient.password_hash),
  mustChangePassword: Boolean(patient.must_change_password),
  lastLoginAt: patient.last_login_at || null,
});

/* ------------------------------------------------------------------ *
 * Shared
 * ------------------------------------------------------------------ */
app.get("/api/health", (_req, res) =>
  res.json({ status: "ok", aiConfigured: aiConfigured(), severityBands: Object.keys(SEVERITY_BANDS) })
);

/** Role-aware, so the client knows which app to render. */
app.get("/api/me", requireAnyone, (req, res) => {
  if (req.doctor) {
    const d = req.doctor;
    return res.json({ role: "doctor", doctor: { id: d.id, name: d.name, email: d.email, username: d.username } });
  }
  const p = req.patient;
  res.json({
    role: "patient",
    patient: {
      id: p.id,
      name: p.name,
      username: p.username,
      mustChangePassword: Boolean(p.must_change_password),
    },
  });
});

/* ------------------------------------------------------------------ *
 * Doctor — patients
 * ------------------------------------------------------------------ */
app.get(
  "/api/patients",
  requireDoctor,
  wrap(async (req, res) => {
    const rows = await db
      .prepare(
        `SELECT p.id, p.name, p.email, p.age, p.username, p.description, p.health_score, p.has_partner,
                p.compliance_score, p.created_at, p.last_login_at,
                (p.password_hash IS NOT NULL) AS has_login,
                pa.name AS partner_name,
                (SELECT MAX(generated_at) FROM reports r WHERE r.patient_id = p.id) AS last_report_at,
                (SELECT COUNT(*) FROM reports r WHERE r.patient_id = p.id) AS report_count
         FROM patients p
         LEFT JOIN partners pa ON pa.patient_id = p.id
         WHERE p.doctor_id = ?
         ORDER BY p.created_at DESC`
      )
      .all(req.doctor.id);
    res.json({ patients: rows });
  })
);

app.post(
  "/api/patients",
  requireDoctor,
  wrap(async (req, res) => {
    const { name, email, age, username, description, health_score, has_partner, partner_name } = req.body || {};

    const errors = [];
    if (!name?.trim()) errors.push("Full name is required");
    if (!email?.trim()) errors.push("Email is required");
    if (!Number.isFinite(Number(age)) || Number(age) <= 0) errors.push("Age must be a positive number");
    if (!username?.trim()) errors.push("Username is required");
    const score = Number(health_score);
    if (!Number.isInteger(score) || score < 1 || score > 10) errors.push("Health score must be a whole number 1-10");
    if (has_partner && !partner_name?.trim()) errors.push("Partner name is required when a partner is attached");
    if (errors.length) return res.status(400).json({ errors });

    if (await db.prepare("SELECT id FROM patients WHERE username = ?").get(username.trim())) {
      return res.status(409).json({ errors: ["That username is already taken"] });
    }

    const info = await db
      .prepare(
        `INSERT INTO patients (doctor_id, name, email, age, username, description, health_score, has_partner)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        req.doctor.id, name.trim(), email.trim(), Number(age), username.trim(),
        description?.trim() || null, score, has_partner ? 1 : 0
      );

    const patientId = Number(info.lastInsertRowid);
    if (has_partner) {
      await db.prepare("INSERT INTO partners (patient_id, name) VALUES (?, ?)").run(patientId, partner_name.trim());
    }

    // Every patient gets a login at creation; the plaintext is shown once.
    const tempPassword = await setPatientPassword(patientId, null, true);

    // A new patient starts with no history. Their record fills up from the two
    // real sources — their own portal check-ins and journals, and JSON import —
    // rather than being pre-populated with invented data at the moment of
    // creation. `compliance_score` stays NULL until there is something to
    // measure, which the dashboard already reads as "no badge".
    //
    // The generator has not gone away: "Regenerate data" still calls it, so a
    // clinician can deliberately conjure a demo dataset. The difference is that
    // it is now an explicit act rather than a side effect of adding a patient.

    res.status(201).json({
      patient: await db.prepare("SELECT * FROM patients WHERE id = ?").get(patientId),
      credentials: { username: username.trim(), tempPassword },
    });
  })
);

app.get(
  "/api/patients/:id",
  requireDoctor,
  wrap(async (req, res) => {
    const data = await loadPatientData(Number(req.params.id));
    if (!data || data.patient.doctor_id !== req.doctor.id) return res.status(404).json({ error: "Patient not found" });

    const reports = await db
      .prepare("SELECT id, generated_at, model_used FROM reports WHERE patient_id = ? ORDER BY generated_at DESC")
      .all(data.patient.id);

    res.json({
      ...data,
      reports,
      severityBucket: bucketForScore(data.patient.health_score),
      credentials: credentialsFor(data.patient),
    });
  })
);

/** Generate or reset a patient's password. Plaintext is returned once, here only. */
app.post(
  "/api/patients/:id/credentials",
  requireDoctor,
  wrap(async (req, res) => {
    const patient = await db.prepare("SELECT * FROM patients WHERE id = ?").get(Number(req.params.id));
    if (!patient || patient.doctor_id !== req.doctor.id) return res.status(404).json({ error: "Patient not found" });

    const custom = req.body?.password ? String(req.body.password) : null;
    if (custom && custom.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    const tempPassword = await setPatientPassword(patient.id, custom, true);
    res.json({ username: patient.username, tempPassword });
  })
);

app.post(
  "/api/patients/:id/regenerate",
  requireDoctor,
  wrap(async (req, res) => {
    const patient = await db.prepare("SELECT * FROM patients WHERE id = ?").get(Number(req.params.id));
    if (!patient || patient.doctor_id !== req.doctor.id) return res.status(404).json({ error: "Patient not found" });

    const nextScore = Number(req.body?.health_score);
    if (Number.isInteger(nextScore) && nextScore >= 1 && nextScore <= 10 && nextScore !== patient.health_score) {
      await db.prepare("UPDATE patients SET health_score = ? WHERE id = ?").run(nextScore, patient.id);
      patient.health_score = nextScore;
    }

    const dataset = generateDataset({
      healthScore: patient.health_score,
      days: TRACKED_DAYS,
      hasPartner: Boolean(patient.has_partner),
    });
    await persistDataset(patient.id, dataset);

    res.json({ ok: true, compliance: dataset.compliance, health_score: patient.health_score });
  })
);

/* ------------------------------------------------------------------ *
 * Doctor — JSON import
 * ------------------------------------------------------------------ */
app.post(
  "/api/import/validate",
  requireDoctor,
  wrap(async (req, res) => {
    const plan = await analyzeImport(req.body?.document, req.doctor, req.body?.options || {});
    res.json({ plan: publicPlan(plan) });
  })
);

app.post(
  "/api/import/commit",
  requireDoctor,
  wrap(async (req, res) => {
    const result = await commitImport(
      req.body?.document,
      req.doctor,
      req.body?.options || {},
      req.body?.filename || null
    );
    res.status(201).json(result);
  })
);

app.get(
  "/api/import/history",
  requireDoctor,
  wrap(async (req, res) => {
    const batches = await db
      .prepare("SELECT * FROM import_batches WHERE doctor_id = ? ORDER BY created_at DESC LIMIT 25")
      .all(req.doctor.id);
    res.json({ batches: batches.map((b) => ({ ...b, summary: parseJson(b.summary, {}) })) });
  })
);

app.post(
  "/api/import/batches/:id/revert",
  requireDoctor,
  wrap(async (req, res) => res.json(await revertImport(Number(req.params.id), req.doctor)))
);

app.get("/api/import/template", requireDoctor, (_req, res) => res.json(IMPORT_TEMPLATE));

/* ------------------------------------------------------------------ *
 * Doctor — reports
 * ------------------------------------------------------------------ */
app.post(
  "/api/patients/:id/reports",
  requireDoctor,
  wrap(async (req, res) => {
    const data = await loadPatientData(Number(req.params.id));
    if (!data || data.patient.doctor_id !== req.doctor.id) return res.status(404).json({ error: "Patient not found" });
    if (data.points.length === 0) {
      return res.status(409).json({ error: "This patient has no data yet — import some or regenerate the dataset" });
    }

    const payload = { ...data, partnerName: data.partner?.name || null };
    const { report, model_used } = await generateReport(payload);
    const guardrail = runGuardrail(report);

    const chartData = {
      from: data.points[0]?.date,
      to: data.points[data.points.length - 1]?.date,
      points: data.points,
      moodLogs: data.moodLogs,
      journals: data.journals,
      partnerMoodLogs: data.partnerMoodLogs,
      partnerJournals: data.partnerJournals,
      partnerName: data.partner?.name || null,
      compliance: data.compliance,
    };

    const info = await db
      .prepare(
        `INSERT INTO reports
          (patient_id, summary_text, insights, spikes, actionable_insights, chart_data, model_used, guardrail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        data.patient.id,
        report.summary || "",
        JSON.stringify(report.insights || []),
        JSON.stringify(report.spikes || []),
        JSON.stringify(report.actionable_insights || []),
        JSON.stringify(chartData),
        model_used,
        JSON.stringify(guardrail)
      );

    res.status(201).json({
      report: rowToReport(await db.prepare("SELECT * FROM reports WHERE id = ?").get(Number(info.lastInsertRowid))),
    });
  })
);

app.get(
  "/api/reports/:id",
  requireDoctor,
  wrap(async (req, res) => {
    const row = await db.prepare("SELECT * FROM reports WHERE id = ?").get(Number(req.params.id));
    if (!row) return res.status(404).json({ error: "Report not found" });
    const patient = await db.prepare("SELECT * FROM patients WHERE id = ?").get(row.patient_id);
    if (patient.doctor_id !== req.doctor.id) return res.status(404).json({ error: "Report not found" });
    res.json({ report: rowToReport(row), patient });
  })
);

app.get(
  "/api/reports/:id/one-pager",
  requireDoctor,
  wrap(async (req, res) => {
    const row = await db.prepare("SELECT * FROM reports WHERE id = ?").get(Number(req.params.id));
    if (!row) return res.status(404).json({ error: "Report not found" });
    const patient = await db.prepare("SELECT * FROM patients WHERE id = ?").get(row.patient_id);
    if (patient.doctor_id !== req.doctor.id) return res.status(404).json({ error: "Report not found" });

    const report = rowToReport(row);
    const content = buildOnePager(report, patient);

    await db
      .prepare(
        // Row-alias form (MySQL 8.0.19+); VALUES(col) here is deprecated.
        `INSERT INTO one_page_summaries (report_id, content) VALUES (?, ?) AS incoming
         ON DUPLICATE KEY UPDATE content = incoming.content`
      )
      .run(report.id, JSON.stringify(content));

    res.json({ onePager: content, patient, report });
  })
);

/* ------------------------------------------------------------------ *
 * Patient portal — a patient only ever sees their own record
 * ------------------------------------------------------------------ */
app.get(
  "/api/portal/me",
  requirePatient,
  wrap(async (req, res) => {
    const data = await loadPatientData(req.patient.id);
    const doctor = await db.prepare("SELECT name FROM doctors WHERE id = ?").get(data.patient.doctor_id);

    // The patient sees their own tracking, not the clinician's framing: no
    // health score, no partner stream, no AI reports.
    res.json({
      patient: {
        id: data.patient.id,
        name: data.patient.name,
        username: data.patient.username,
        age: data.patient.age,
        mustChangePassword: Boolean(data.patient.must_change_password),
      },
      doctorName: doctor?.name || null,
      points: data.points,
      moodLogs: data.moodLogs,
      journals: data.journals,
      compliance: data.compliance,
    });
  })
);

app.post(
  "/api/portal/mood",
  requirePatient,
  wrap(async (req, res) => {
    const rating = Number(req.body?.mood_rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 10) {
      return res.status(400).json({ error: "Mood rating must be a whole number 1-10" });
    }

    const tags = Array.isArray(req.body?.tags) ? req.body.tags.map((t) => String(t).slice(0, 40)).slice(0, 4) : [];
    const date = new Date().toISOString().slice(0, 10);

    // One check-in per day — a second submission replaces the first.
    await db.prepare("DELETE FROM mood_logs WHERE patient_id = ? AND author = 'patient' AND date = ?").run(
      req.patient.id, date
    );
    await db.prepare(
      "INSERT INTO mood_logs (patient_id, author, date, mood_rating, tags, source) VALUES (?, 'patient', ?, ?, ?, 'self-reported')"
    ).run(req.patient.id, date, rating, JSON.stringify(tags));

    const points = await db.prepare("SELECT date FROM simulated_data_points WHERE patient_id = ?").all(req.patient.id);
    const moods = await db
      .prepare("SELECT date FROM mood_logs WHERE patient_id = ? AND author = 'patient'")
      .all(req.patient.id);
    if (points.length) {
      const compliance = computeCompliance(points, moods);
      await db.prepare("UPDATE patients SET compliance_score = ? WHERE id = ?").run(compliance.score, req.patient.id);
    }

    res.status(201).json({ ok: true, date });
  })
);

app.post(
  "/api/portal/journal",
  requirePatient,
  wrap(async (req, res) => {
    const text = String(req.body?.text || "").trim();
    if (!text) return res.status(400).json({ error: "Write something first" });
    if (text.length > 5000) return res.status(400).json({ error: "Entry is too long (max 5000 characters)" });

    const date = new Date().toISOString().slice(0, 10);
    await db.prepare(
      "INSERT INTO journal_entries (patient_id, author, date, snippet_id, text, source) VALUES (?, 'patient', ?, NULL, ?, 'self-reported')"
    ).run(req.patient.id, date, text);

    res.status(201).json({ ok: true, date });
  })
);

/* ------------------------------------------------------------------ */
app.use((err, _req, res, _next) => {
  if (err?.status) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: err.message || "Internal server error" });
});

const PORT = Number(process.env.PORT || 4100);
app.listen(PORT, () => {
  console.log(`Mindbridge API on http://localhost:${PORT}`);
  console.log(`DB: ${process.env.MINDBRIDGE_DB_NAME}@${process.env.MINDBRIDGE_DB_HOST} (tables prefixed "${process.env.MINDBRIDGE_TABLE_PREFIX ?? "mb_"}")`);
  console.log(`AI: ${aiDescription()}`);
  console.log(`Doctor login: ${DOCTOR.username} / ${process.env.MINDBRIDGE_DOCTOR_PASSWORD || "mindbridge"}`);
});

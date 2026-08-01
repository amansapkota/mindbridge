/**
 * Demo data. Creates three patients spanning the severity range so the
 * dashboard has something to show immediately. Safe to re-run — it skips
 * usernames that already exist.
 */
import { db, withTransaction, migrate, loadSnippetPool, ensureDefaultDoctor, closePool } from "./db.js";
import { SNIPPETS, generateDataset } from "./generator.js";
import { setPatientPassword } from "./auth.js";

await migrate();
await loadSnippetPool(SNIPPETS);
const doctor = await ensureDefaultDoctor();

const DEMO = [
  {
    name: "Daniel Okafor",
    email: "daniel.o@example.com",
    age: 34,
    username: "danielo",
    description:
      "Referred after relationship breakdown. Reports poor sleep and increased alcohol use. Seen monthly.",
    health_score: 2,
    partner_name: "Rachel",
  },
  {
    name: "Marcus Bell",
    email: "marcus.bell@example.com",
    age: 29,
    username: "marcusb",
    description: "Self-referred, work-related stress and disrupted sleep. Fortnightly sessions.",
    health_score: 5,
    partner_name: "Jen",
  },
  {
    name: "Priya Raman",
    email: "priya.r@example.com",
    age: 41,
    username: "priyar",
    description: "Maintenance phase, stable for six months. Quarterly review.",
    health_score: 8,
    partner_name: null,
  },
];

for (const d of DEMO) {
  const existing = await db.prepare("SELECT id FROM patients WHERE username = ?").get(d.username);
  if (existing) {
    console.log(`skip  ${d.username} (already exists)`);
    continue;
  }

  const dataset = generateDataset({
    healthScore: d.health_score,
    days: 30,
    hasPartner: Boolean(d.partner_name),
  });

  const patientId = await withTransaction(async (tx) => {
    const info = await tx
      .prepare(
        `INSERT INTO patients (doctor_id, name, email, age, username, description, health_score, has_partner)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(doctor.id, d.name, d.email, d.age, d.username, d.description, d.health_score, d.partner_name ? 1 : 0);

    const id = Number(info.lastInsertRowid);
    if (d.partner_name) {
      await tx.prepare("INSERT INTO partners (patient_id, name) VALUES (?, ?)").run(id, d.partner_name);
    }

    await tx.insertMany(
      `INSERT INTO simulated_data_points
         (patient_id, date, sleep_hours, sleep_quality, resting_hr, hrv, breathing_rate,
          mood_score, anxiety_score, energy_score)
       VALUES ?`,
      dataset.points.map((p) => [
        id, p.date, p.sleep_hours, p.sleep_quality, p.resting_hr, p.hrv,
        p.breathing_rate, p.mood_score, p.anxiety_score, p.energy_score,
      ])
    );

    const moods = dataset.patient.moodLogs.map((m) => [id, "patient", m.date, m.mood_rating, JSON.stringify(m.tags)]);
    const journals = dataset.patient.journals.map((j) => [id, "patient", j.date, j.snippet_id, j.text]);
    if (dataset.partner) {
      for (const m of dataset.partner.moodLogs) moods.push([id, "partner", m.date, m.mood_rating, JSON.stringify(m.tags)]);
      for (const j of dataset.partner.journals) journals.push([id, "partner", j.date, j.snippet_id, j.text]);
    }

    await tx.insertMany("INSERT INTO mood_logs (patient_id, author, date, mood_rating, tags) VALUES ?", moods);
    await tx.insertMany("INSERT INTO journal_entries (patient_id, author, date, snippet_id, text) VALUES ?", journals);

    await tx.prepare("UPDATE patients SET compliance_score = ? WHERE id = ?").run(dataset.compliance.score, id);
    return id;
  });

  const tempPassword = await setPatientPassword(patientId, null, true);
  console.log(
    `created ${d.username.padEnd(10)} health ${d.health_score}  compliance ${String(dataset.compliance.score).padStart(3)}%  password ${tempPassword}`
  );
}

console.log("\nClinician:  drsmith / mindbridge");
console.log("Patients:   sign in with the username and password printed above.");
console.log("Run `npm run credentials` at any time to see who has a login, or to reset one.");

await closePool();

import { db, rowToReport, closePool } from "./db.js";
const row = await db.prepare("SELECT * FROM reports WHERE id = ?").get(2);
const r = rowToReport(row);
const p = await db.prepare("SELECT * FROM patients WHERE id = ?").get(r.patient_id);
console.log(JSON.stringify({
  patient: { name: p.name, age: p.age, health_score: p.health_score, description: p.description },
  window: { from: r.chart_data.from, to: r.chart_data.to, compliance: r.chart_data.compliance.score, missed: r.chart_data.compliance.missedDates.length },
  model: r.model_used, guardrail: r.guardrail,
  insights: r.insights, spikes: r.spikes, actionable: r.actionable_insights,
}, null, 1));
await closePool();

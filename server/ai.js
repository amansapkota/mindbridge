/**
 * Generate Report (PRD 6.6).
 *
 * One provider, configured by env (per the build advice — no model-swap layer
 * until a second model is actually in use). Because it is an OpenAI-compatible
 * chat-completions call, pointing MINDBRIDGE_BASE_URL at OpenRouter or a Gemini
 * compatibility endpoint works without code changes.
 *
 * With no API key configured the module falls back to a local analysis pass so
 * the create -> generate -> report loop is demoable offline. The fallback is
 * genuinely derived from the patient's data (trends, correlations, spike days,
 * partner mismatches), not canned text, and labels itself as such.
 */

const API_KEY = process.env.MINDBRIDGE_API_KEY || process.env.OPENAI_API_KEY || "";
const BASE_URL = process.env.MINDBRIDGE_BASE_URL || "https://api.openai.com/v1";
const MODEL = process.env.MINDBRIDGE_MODEL || "gpt-4o-mini";

export const aiConfigured = () => Boolean(API_KEY);

const SYSTEM_PROMPT = `You are a clinical data analyst supporting a psychiatrist or therapist. You review between-session wellbeing data for ONE patient and produce a structured briefing the doctor reads before a session.

HARD CONSTRAINTS — these are absolute:
- NEVER diagnose. Never name, suggest, imply or rule out any clinical diagnosis or disorder.
- Never recommend or adjust medication, dosage or treatment.
- You describe patterns in data. You do not interpret them as illness.
- Write for a clinician: neutral, concise, specific. No patient-facing reassurance, no motivational language.

WHAT TO DO:
- Summarise the overall pattern across the tracked window, naming concrete date ranges.
- Identify notable spikes, dips and anomalies, each with its date and what actually moved.
- Surface correlations worth attention — especially where biometric/EMA changes coincide with what the patient wrote in their journal or mood tags on the same or adjacent days. Quote or paraphrase the journal briefly when it explains a movement.
- Where a partner/observer stream is present, point out days where the patient's self-report and the partner's observation do not agree, and say plainly what each reported.
- Note logging gaps (missing check-ins) as a data-quality caveat, not as a patient failing.
- Give actionable, NON-DIAGNOSTIC suggestions: what to ask about, what to monitor, which dates to explore. Phrase as "consider asking about..." / "worth monitoring...".

Be specific to THIS dataset. Generic wellbeing advice is a failure. Every claim must trace to a date or a number in the data provided.

Return ONLY valid JSON, no markdown fence, matching exactly:
{
  "summary": "string, 3-6 sentences",
  "insights": [{"title": "string", "detail": "string", "evidence": "string"}],
  "spikes": [{"date": "YYYY-MM-DD", "metric": "string", "description": "string", "journal_context": "string or empty"}],
  "actionable_insights": [{"suggestion": "string", "rationale": "string"}]
}
Aim for 3-5 insights, 2-5 spikes, 3-4 actionable insights.`;

/** Compact serialisation — CSV for the series, so the prompt stays cheap. */
export function buildUserPrompt({ patient, partnerName, points, moodLogs, journals, partnerMoodLogs, partnerJournals, compliance }) {
  const lines = [];

  lines.push(`PATIENT CONTEXT`);
  lines.push(`Age: ${patient.age}`);
  lines.push(`Baseline health score (1 severe - 10 thriving), set by the clinician at intake: ${patient.health_score}`);
  if (patient.description) lines.push(`Clinician's notes at intake: ${patient.description}`);
  lines.push(`Tracked window: ${points[0]?.date} to ${points[points.length - 1]?.date} (${points.length} days)`);
  lines.push(
    `Check-in compliance: ${compliance.score}% (${compliance.logged}/${compliance.expected} days logged).` +
      (compliance.missedDates.length ? ` Missing: ${compliance.missedDates.join(", ")}` : "")
  );

  lines.push(`\nDAILY BIOMETRIC + EMA DATA (csv)`);
  lines.push(`date,sleep_hours,sleep_quality_0_100,resting_hr,hrv,breathing_rate,mood_1_10,anxiety_1_10,energy_1_10`);
  for (const p of points) {
    lines.push(
      [p.date, p.sleep_hours, p.sleep_quality, p.resting_hr, p.hrv, p.breathing_rate, p.mood_score, p.anxiety_score, p.energy_score].join(",")
    );
  }

  lines.push(`\nPATIENT MOOD CHECK-INS (date, rating 1-10, tags)`);
  for (const m of moodLogs) lines.push(`${m.date}, ${m.mood_rating}, [${m.tags.join(", ")}]`);

  lines.push(`\nPATIENT JOURNAL ENTRIES`);
  for (const j of journals) lines.push(`${j.date}: ${j.text}`);

  if (partnerMoodLogs?.length || partnerJournals?.length) {
    lines.push(`\nPARTNER/OBSERVER STREAM — written by ${partnerName || "the patient's partner"} about the patient, same window`);
    lines.push(`PARTNER MOOD OBSERVATIONS (date, rating 1-10, tags)`);
    for (const m of partnerMoodLogs) lines.push(`${m.date}, ${m.mood_rating}, [${m.tags.join(", ")}]`);
    lines.push(`PARTNER JOURNAL ENTRIES`);
    for (const j of partnerJournals) lines.push(`${j.date}: ${j.text}`);
    lines.push(`Note: where the patient's and partner's accounts of the same day disagree, say so explicitly.`);
  }

  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * Guardrail (PRD 6.6) — cheap keyword check, deliberately not clever.
 * ------------------------------------------------------------------ */
const DIAGNOSTIC_PATTERNS = [
  /\bdiagnos(is|e|ed|es|ing|tic)\b/i,
  /\bmajor depressive\b/i,
  /\bclinical(ly)? depress/i,
  /\bbipolar\b/i,
  /\bschizophreni/i,
  /\bptsd\b/i,
  /\bpost-traumatic stress\b/i,
  /\bgenerali[sz]ed anxiety disorder\b/i,
  /\bpanic disorder\b/i,
  /\bborderline personality\b/i,
  /\bocd\b/i,
  /\badhd\b/i,
  /\balcohol use disorder\b/i,
  /\bsubstance use disorder\b/i,
  /\bmeets criteria\b/i,
  /\bprescrib(e|ing|ed)\b/i,
  /\b(increase|decrease|adjust) (the )?(dose|dosage|medication)\b/i,
];

export function runGuardrail(report) {
  const haystack = [
    report.summary,
    ...(report.insights || []).flatMap((i) => [i.title, i.detail, i.evidence]),
    ...(report.spikes || []).flatMap((s) => [s.description, s.journal_context]),
    ...(report.actionable_insights || []).flatMap((a) => [a.suggestion, a.rationale]),
  ]
    .filter(Boolean)
    .join("\n");

  const matches = [];
  for (const pattern of DIAGNOSTIC_PATTERNS) {
    const hit = haystack.match(pattern);
    if (hit) matches.push(hit[0]);
  }
  return { passed: matches.length === 0, matches: [...new Set(matches)] };
}

/* ------------------------------------------------------------------ *
 * Provider call
 * ------------------------------------------------------------------ */
async function callModel(userPrompt) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Model call failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Model returned no content");

  // Strip a markdown fence if the model added one despite instructions.
  const cleaned = content.trim().replace(/^```(?:json)?/, "").replace(/```$/, "").trim();
  return JSON.parse(cleaned);
}

/* ------------------------------------------------------------------ *
 * Offline fallback — real analysis of the same data.
 * ------------------------------------------------------------------ */
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return 0;
  const mx = mean(xs.slice(0, n));
  const my = mean(ys.slice(0, n));
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}

const fmt = (n, d = 1) => Number(n).toFixed(d);
const prettyDate = (d) => new Date(d + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });

function offlineReport({ points, moodLogs, journals, partnerMoodLogs, partnerJournals, partnerName, compliance }) {
  const firstThird = points.slice(0, Math.floor(points.length / 3));
  const lastThird = points.slice(-Math.floor(points.length / 3));

  const delta = (key) => mean(lastThird.map((p) => p[key])) - mean(firstThird.map((p) => p[key]));
  const dir = (v, unit = "") =>
    `${v >= 0 ? "up" : "down"} ${fmt(Math.abs(v))}${unit}`;

  const moodDelta = delta("mood_score");
  const sleepDelta = delta("sleep_hours");
  const anxietyDelta = delta("anxiety_score");
  const hrDelta = delta("resting_hr");

  const journalByDate = new Map(journals.map((j) => [j.date, j.text]));

  // Worst days by a simple composite of low mood, high anxiety and short sleep.
  const scored = points
    .map((p) => ({ ...p, burden: (10 - p.mood_score) + p.anxiety_score + Math.max(0, 7 - p.sleep_hours) * 1.5 }))
    .sort((a, b) => b.burden - a.burden);

  const spikes = scored.slice(0, 4).map((p) => ({
    date: p.date,
    metric: p.sleep_hours < 5 ? "sleep_hours" : p.anxiety_score >= 7 ? "anxiety_score" : "mood_score",
    description: `Mood ${p.mood_score}/10, anxiety ${p.anxiety_score}/10, ${fmt(p.sleep_hours)}h sleep (quality ${p.sleep_quality}/100), resting HR ${p.resting_hr}bpm.`,
    journal_context: journalByDate.get(p.date) || "",
  }));

  const moodVsSleep = pearson(points.map((p) => p.mood_score), points.map((p) => p.sleep_hours));
  const anxVsHr = pearson(points.map((p) => p.anxiety_score), points.map((p) => p.resting_hr));

  const insights = [
    {
      title: `Mood trend ${moodDelta >= 0 ? "improving" : "declining"} across the window`,
      detail: `Average mood moved ${dir(moodDelta)} points between the first and last third of the window, with anxiety ${dir(anxietyDelta)} over the same period.`,
      evidence: `First third mean mood ${fmt(mean(firstThird.map((p) => p.mood_score)))}/10 vs last third ${fmt(mean(lastThird.map((p) => p.mood_score)))}/10.`,
    },
    {
      title: `Sleep and mood move together (r = ${fmt(moodVsSleep, 2)})`,
      detail:
        Math.abs(moodVsSleep) > 0.4
          ? `Shorter nights line up with lower same-day mood ratings across the window, a fairly consistent relationship in this dataset.`
          : `Sleep duration and mood track only loosely here, so short nights alone do not explain the low-mood days.`,
      evidence: `Sleep averaged ${fmt(mean(points.map((p) => p.sleep_hours)))}h/night overall and moved ${dir(sleepDelta, "h")} across the window.`,
    },
    {
      title: `Resting heart rate ${hrDelta >= 0 ? "rising" : "settling"}`,
      detail: `Resting HR moved ${dir(hrDelta, "bpm")} between the first and last third; its correlation with self-reported anxiety is r = ${fmt(anxVsHr, 2)}.`,
      evidence: `Mean resting HR ${fmt(mean(points.map((p) => p.resting_hr)), 0)}bpm, HRV ${fmt(mean(points.map((p) => p.hrv)), 0)}ms.`,
    },
  ];

  if (compliance.score < 85) {
    insights.push({
      title: `Check-in gaps limit confidence`,
      detail: `${compliance.expected - compliance.logged} of ${compliance.expected} days have no check-in, so quiet stretches may be under-represented rather than genuinely settled.`,
      evidence: `Missing: ${compliance.missedDates.slice(0, 8).map(prettyDate).join(", ")}${compliance.missedDates.length > 8 ? ", ..." : ""}.`,
    });
  }

  // Days where the two accounts disagree by 3+ points.
  const mismatches = [];
  if (partnerMoodLogs?.length) {
    const patientByDate = new Map(moodLogs.map((m) => [m.date, m]));
    for (const pm of partnerMoodLogs) {
      const own = patientByDate.get(pm.date);
      if (own && Math.abs(own.mood_rating - pm.mood_rating) >= 3) {
        mismatches.push({ date: pm.date, patient: own.mood_rating, partner: pm.mood_rating });
      }
    }
    if (mismatches.length) {
      const worst = mismatches.sort((a, b) => Math.abs(b.patient - b.partner) - Math.abs(a.patient - a.partner))[0];
      insights.push({
        title: `Patient and ${partnerName || "partner"} accounts diverge on ${mismatches.length} day${mismatches.length === 1 ? "" : "s"}`,
        detail: `The largest gap is ${prettyDate(worst.date)}: the patient rated their mood ${worst.patient}/10 while ${partnerName || "their partner"} rated the same day ${worst.partner}/10.`,
        evidence: `Divergent days: ${mismatches.slice(0, 6).map((m) => `${prettyDate(m.date)} (${m.patient} vs ${m.partner})`).join("; ")}.`,
      });
    }
  }

  const actionable = [
    {
      suggestion: `Consider asking about the period around ${prettyDate(spikes[0].date)}.`,
      rationale: `That day carries the heaviest combination of low mood, elevated anxiety and short sleep in the window${journalByDate.get(spikes[0].date) ? `, and the journal entry that day reads: "${journalByDate.get(spikes[0].date).slice(0, 120)}..."` : "."}`,
    },
    {
      suggestion: `Worth monitoring sleep as a leading indicator over the next fortnight.`,
      rationale: `Sleep averaged ${fmt(mean(points.map((p) => p.sleep_hours)))}h with quality at ${fmt(mean(points.map((p) => p.sleep_quality)), 0)}/100; its relationship to same-day mood in this window is r = ${fmt(moodVsSleep, 2)}.`,
    },
  ];

  if (compliance.score < 85) {
    actionable.push({
      suggestion: `Consider exploring what makes check-ins harder on the days they are missed.`,
      rationale: `Compliance is ${compliance.score}%, and gaps cluster rather than spread evenly — the reason for the gap may itself be informative.`,
    });
  }
  if (mismatches.length) {
    actionable.push({
      suggestion: `Consider reviewing ${prettyDate(mismatches[0].date)} with both accounts in the room, if appropriate.`,
      rationale: `Self-report and observer report differ by ${Math.abs(mismatches[0].patient - mismatches[0].partner)} points that day, which may be worth understanding rather than resolving.`,
    });
  }

  const summary =
    `Across ${points.length} tracked days, average mood sat at ${fmt(mean(points.map((p) => p.mood_score)))}/10 and anxiety at ${fmt(mean(points.map((p) => p.anxiety_score)))}/10, ` +
    `with sleep averaging ${fmt(mean(points.map((p) => p.sleep_hours)))} hours a night. ` +
    `Comparing the opening and closing thirds of the window, mood is ${dir(moodDelta)} points, anxiety ${dir(anxietyDelta)} points and sleep ${dir(sleepDelta, "h")}. ` +
    `${spikes.length} days stand out as notably harder than the surrounding pattern, the heaviest being ${prettyDate(spikes[0].date)}. ` +
    (mismatches.length ? `The observer stream disagrees with the patient's own rating on ${mismatches.length} day${mismatches.length === 1 ? "" : "s"}. ` : "") +
    `Check-in compliance was ${compliance.score}%, ${compliance.score < 85 ? "so quieter stretches should be read with some caution" : "so coverage is good across the window"}.`;

  return { summary, insights, spikes, actionable_insights: actionable };
}

/* ------------------------------------------------------------------ *
 * Public entry point
 * ------------------------------------------------------------------ */
export async function generateReport(payload) {
  if (!aiConfigured()) {
    const report = offlineReport(payload);
    return { report, model_used: "offline-analysis (no API key configured)" };
  }

  const userPrompt = buildUserPrompt(payload);
  try {
    const report = await callModel(userPrompt);
    return { report, model_used: MODEL };
  } catch (err) {
    // A failed call should not dead-end the doctor mid-session.
    const report = offlineReport(payload);
    return { report, model_used: `offline-analysis (${MODEL} failed: ${err.message.slice(0, 120)})` };
  }
}

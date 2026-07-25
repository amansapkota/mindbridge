/**
 * One-Page Summary (PRD 6.8).
 *
 * Condenses an already-generated report. This makes no AI call and adds no new
 * analysis — it selects and trims what the report already contains, which is
 * exactly the acceptance criterion.
 */

const trim = (text, max) => {
  if (!text) return "";
  const clean = String(text).trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return (lastStop > max * 0.6 ? cut.slice(0, lastStop + 1) : cut.trimEnd() + "…").trim();
};

export function buildOnePager(report, patient) {
  const chart = report.chart_data || {};
  const compliance = chart.compliance || {};

  return {
    patient: {
      name: patient.name,
      username: patient.username,
      age: patient.age,
      health_score: patient.health_score,
    },
    window: { from: chart.from || null, to: chart.to || null },
    generated_at: report.generated_at,
    model_used: report.model_used,
    compliance: {
      score: compliance.score ?? patient.compliance_score ?? null,
      missed: (compliance.missedDates || []).length,
      expected: compliance.expected ?? null,
    },
    // Headline: the report summary, kept to roughly one paragraph.
    headline: trim(report.summary_text, 520),
    // Top 3 of each list — enough to be useful, few enough to fit a page.
    key_observations: (report.insights || []).slice(0, 3).map((i) => ({
      title: trim(i.title, 90),
      detail: trim(i.detail, 200),
    })),
    notable_days: (report.spikes || []).slice(0, 3).map((s) => ({
      date: s.date,
      metric: s.metric,
      description: trim(s.description, 160),
      journal_context: trim(s.journal_context, 140),
    })),
    discussion_points: (report.actionable_insights || []).slice(0, 3).map((a) => ({
      suggestion: trim(a.suggestion, 140),
      rationale: trim(a.rationale, 180),
    })),
    disclaimer:
      "Mindbridge is a decision-support tool. This summary describes patterns in self-reported and sensor data and is not a diagnosis or a treatment recommendation.",
  };
}

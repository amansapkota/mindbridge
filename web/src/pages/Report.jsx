import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api.js";
import { MetricChart, MoodChart, MoodComparisonChart, SleepChart, shortDate, useThemeColors } from "../components/Charts.jsx";
import { ComplianceCard, JournalTimeline, PartnerCompare } from "../components/Panels.jsx";

const AiLabel = () => (
  <span className="ai-flag">
    <span className="dot" style={{ background: "var(--ai-edge)" }} /> AI interpretation
  </span>
);

const DataLabel = ({ children }) => (
  <span className="data-flag">
    <span className="dot" style={{ background: "var(--text-muted)" }} /> {children || "Recorded data"}
  </span>
);

export default function Report() {
  const { id } = useParams();
  const colors = useThemeColors();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get(`/reports/${id}`).then(setData).catch((e) => setError(e.message));
  }, [id]);

  if (error) return <main className="page"><div className="error-box">{error}</div></main>;
  if (!data) return <main className="page"><p className="muted">Loading…</p></main>;

  const { report, patient } = data;
  const chart = report.chart_data || {};
  const points = chart.points || [];
  const spikeDates = (report.spikes || []).map((s) => s.date);

  return (
    <main className="page">
      <Link to={`/patients/${patient.id}`} className="back-link no-print">← Back to {patient.name}</Link>

      <div className="page-head">
        <div>
          <h1>{patient.name} — clinical briefing</h1>
          <p className="page-sub">
            {chart.from && chart.to ? `${shortDate(chart.from)} – ${shortDate(chart.to)}` : "Tracked window"} ·{" "}
            {points.length} days · generated{" "}
            {new Date(report.generated_at.replace(" ", "T") + "Z").toLocaleString("en-GB", {
              day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
            })}
          </p>
          <p className="page-sub muted">Model: {report.model_used}</p>
        </div>
        <div className="btn-row no-print">
          <Link to={`/reports/${report.id}/one-pager`} className="btn btn-primary">
            One-page summary
          </Link>
        </div>
      </div>

      {report.guardrail && report.guardrail.passed === false && (
        <div className="notice" style={{ marginBottom: "1rem" }}>
          <strong>Guardrail flagged this output.</strong> Possible diagnostic language detected:{" "}
          {report.guardrail.matches.map((m) => `“${m}”`).join(", ")}. Mindbridge does not diagnose — read the
          flagged wording with that in mind.
        </div>
      )}

      {/* ---------- AI summary ---------- */}
      <div className="card">
        <div className="ai-block">
          <AiLabel />
          <h2 style={{ marginBottom: "0.5rem" }}>Summary</h2>
          <p style={{ fontSize: "0.95rem" }}>{report.summary_text}</p>
        </div>
      </div>

      <div className="grid grid-2" style={{ marginTop: "1rem" }}>
        <div className="stack">
          {/* ---------- data ---------- */}
          <div className="card">
            <DataLabel />
            <div className="card-head">
              <span className="card-title">Mood, anxiety and energy</span>
              <span className="card-note">Red markers = days the report flagged</span>
            </div>
            <div className="chart-scroll">
              <MoodChart points={points} spikeDates={spikeDates} />
            </div>
          </div>

          <div className="card">
            <DataLabel />
            <div className="card-head">
              <span className="card-title">Sleep duration</span>
              <span className="card-note">Hours per night</span>
            </div>
            <div className="chart-scroll">
              <SleepChart points={points} spikeDates={spikeDates} />
            </div>
          </div>

          <div className="card">
            <DataLabel />
            <div className="card-head">
              <span className="card-title">Physiological signals</span>
            </div>
            <div className="grid grid-2">
              <div>
                <p className="card-note">Resting heart rate (bpm)</p>
                <MetricChart points={points} dataKey="resting_hr" name="Resting HR" unit="bpm" color={colors.series2} />
              </div>
              <div>
                <p className="card-note">Heart rate variability (ms)</p>
                <MetricChart points={points} dataKey="hrv" name="HRV" unit="ms" color={colors.series3} />
              </div>
            </div>
          </div>
        </div>

        <div className="stack">
          {/* ---------- AI: spikes ---------- */}
          <div className="card">
            <div className="ai-block">
              <AiLabel />
              <div className="card-head">
                <span className="card-title">Notable days</span>
                <span className="card-note">{report.spikes.length} flagged</span>
              </div>
              {report.spikes.length === 0 ? (
                <p className="muted" style={{ fontSize: "0.85rem" }}>Nothing stood out in this window.</p>
              ) : (
                report.spikes.map((s, i) => (
                  <div className="insight" key={`${s.date}-${i}`}>
                    <div className="insight-title">
                      <span className="dot" style={{ background: "var(--critical)", marginRight: "0.4rem" }} />
                      {shortDate(s.date)} · <span className="muted">{s.metric}</span>
                    </div>
                    <p className="insight-detail">{s.description}</p>
                    {s.journal_context && (
                      <p className="insight-evidence" style={{ fontStyle: "italic" }}>
                        Journal that day: “{s.journal_context}”
                      </p>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          {/* ---------- AI: insights ---------- */}
          <div className="card">
            <div className="ai-block">
              <AiLabel />
              <div className="card-head">
                <span className="card-title">Insights</span>
              </div>
              {report.insights.map((ins, i) => (
                <div className="insight" key={i}>
                  <div className="insight-title">{ins.title}</div>
                  <p className="insight-detail">{ins.detail}</p>
                  {ins.evidence && <p className="insight-evidence">{ins.evidence}</p>}
                </div>
              ))}
            </div>
          </div>

          {/* ---------- AI: actionable ---------- */}
          <div className="card">
            <div className="ai-block">
              <AiLabel />
              <div className="card-head">
                <span className="card-title">Suggested discussion points</span>
                <span className="card-note">Non-diagnostic</span>
              </div>
              {report.actionable_insights.map((a, i) => (
                <div className="insight" key={i}>
                  <div className="insight-title">{a.suggestion}</div>
                  <p className="insight-detail">{a.rationale}</p>
                </div>
              ))}
            </div>
          </div>

          <ComplianceCard compliance={chart.compliance} />
        </div>
      </div>

      <div className="card" style={{ marginTop: "1rem" }}>
        <DataLabel />
        <div className="card-head">
          <span className="card-title">Journal & mood timeline</span>
          <span className="card-note">Flagged days highlighted</span>
        </div>
        <JournalTimeline journals={chart.journals} moodLogs={chart.moodLogs} flaggedDates={spikeDates} />
      </div>

      {chart.partnerMoodLogs?.length > 0 && (
        <div className="card" style={{ marginTop: "1rem" }}>
          <DataLabel>Recorded data · two sources</DataLabel>
          <div className="card-head">
            <span className="card-title">Patient vs {chart.partnerName || "partner"}</span>
            <span className="card-note">Highlighted rows differ by 3+ points</span>
          </div>
          <div className="chart-scroll" style={{ marginBottom: "1rem" }}>
            <MoodComparisonChart
              patientLogs={chart.moodLogs || []}
              partnerLogs={chart.partnerMoodLogs}
              partnerName={chart.partnerName}
            />
          </div>
          <PartnerCompare
            patientMoods={chart.moodLogs || []}
            partnerMoods={chart.partnerMoodLogs}
            patientJournals={chart.journals || []}
            partnerJournals={chart.partnerJournals || []}
            partnerName={chart.partnerName}
          />
        </div>
      )}

      <p className="disclaimer">
        Mindbridge is a decision-support tool, not a diagnostic one. Purple-edged blocks are AI-generated
        interpretation of the recorded data; unmarked panels are the recorded data itself. Clinical judgement
        remains with the treating clinician.
      </p>
    </main>
  );
}

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api.js";
import { shortDate } from "../components/Charts.jsx";

/**
 * PRD 6.8 — a condensed view of the already-generated report. No new AI call:
 * the server derives this from the saved Report row.
 */
export default function OnePager() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get(`/reports/${id}/one-pager`).then(setData).catch((e) => setError(e.message));
  }, [id]);

  if (error) return <main className="page"><div className="error-box">{error}</div></main>;
  if (!data) return <main className="page"><p className="muted">Loading…</p></main>;

  const { onePager: op } = data;

  return (
    <main className="page onepager" style={{ maxWidth: 820 }}>
      <div className="no-print">
        <Link to={`/reports/${id}`} className="back-link">← Back to full report</Link>
      </div>

      <div className="page-head">
        <div>
          <h1>{op.patient.name}</h1>
          <p className="page-sub">
            @{op.patient.username} · {op.patient.age} years · baseline health score {op.patient.health_score}/10
          </p>
          <p className="page-sub muted">
            {op.window.from && op.window.to ? `${shortDate(op.window.from)} – ${shortDate(op.window.to)}` : ""} ·
            check-in compliance {op.compliance.score}%
            {op.compliance.missed ? ` (${op.compliance.missed} days missed)` : ""}
          </p>
        </div>
        <div className="btn-row no-print">
          <button className="btn-primary" onClick={() => window.print()}>
            Print / save as PDF
          </button>
        </div>
      </div>

      <section style={{ marginBottom: "1.25rem" }}>
        <h2 style={{ marginBottom: "0.4rem" }}>Summary</h2>
        <p>{op.headline}</p>
      </section>

      <section style={{ marginBottom: "1.25rem" }}>
        <h2 style={{ marginBottom: "0.4rem" }}>Key observations</h2>
        {op.key_observations.map((o, i) => (
          <div key={i} style={{ marginBottom: "0.5rem" }}>
            <strong style={{ fontSize: "0.92rem" }}>{o.title}</strong>
            <p className="insight-detail">{o.detail}</p>
          </div>
        ))}
      </section>

      <section style={{ marginBottom: "1.25rem" }}>
        <h2 style={{ marginBottom: "0.4rem" }}>Notable days</h2>
        {op.notable_days.map((d, i) => (
          <div key={i} style={{ marginBottom: "0.5rem" }}>
            <strong style={{ fontSize: "0.92rem" }}>{shortDate(d.date)}</strong>
            <p className="insight-detail">{d.description}</p>
            {d.journal_context && (
              <p className="insight-evidence" style={{ fontStyle: "italic" }}>“{d.journal_context}”</p>
            )}
          </div>
        ))}
      </section>

      <section style={{ marginBottom: "1.25rem" }}>
        <h2 style={{ marginBottom: "0.4rem" }}>Discussion points</h2>
        <ol style={{ margin: 0, paddingLeft: "1.2rem" }}>
          {op.discussion_points.map((d, i) => (
            <li key={i} style={{ marginBottom: "0.4rem" }}>
              <strong style={{ fontSize: "0.92rem" }}>{d.suggestion}</strong>
              <p className="insight-detail">{d.rationale}</p>
            </li>
          ))}
        </ol>
      </section>

      <p className="disclaimer">
        {op.disclaimer} Generated {new Date(op.generated_at.replace(" ", "T") + "Z").toLocaleString("en-GB")} · {op.model_used}
      </p>
    </main>
  );
}

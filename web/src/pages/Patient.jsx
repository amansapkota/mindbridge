import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { MetricChart, MoodChart, MoodComparisonChart, SleepChart, useThemeColors } from "../components/Charts.jsx";
import { ComplianceCard, JournalTimeline, PartnerCompare, StatTile } from "../components/Panels.jsx";

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const fmt = (n, d = 1) => Number(n).toFixed(d);

const bucketLabel = { high: "High severity", moderate: "Moderate", stable: "Stable" };

/**
 * The patient's own login. Passwords are only ever shown here, once, right
 * after they are generated — the server stores a scrypt hash and cannot
 * retrieve them again.
 */
function PatientLogin({ patientId, credentials }) {
  const [issued, setIssued] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const issue = async () => {
    setBusy(true);
    setError(null);
    try {
      setIssued(await api.post(`/patients/${patientId}/credentials`));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Patient login</span>
        <span className="card-note">
          {credentials.lastLoginAt
            ? `last signed in ${new Date(credentials.lastLoginAt.replace(" ", "T") + "Z").toLocaleDateString("en-GB")}`
            : "never signed in"}
        </span>
      </div>

      <div className="cred-row">
        <span className="muted">Username</span>
        <code>{credentials.username}</code>
      </div>
      <div className="cred-row">
        <span className="muted">Password</span>
        <span>
          {credentials.hasPassword ? (
            credentials.mustChangePassword ? (
              <span className="badge badge-moderate">temporary — not yet changed</span>
            ) : (
              <span className="badge badge-stable">set by patient</span>
            )
          ) : (
            <span className="badge badge-high">not set</span>
          )}
        </span>
      </div>

      {issued && (
        <div className="notice" style={{ marginTop: "0.7rem" }}>
          <strong>Temporary password — shown once.</strong>
          <div className="cred-box">
            <div className="cred-row">
              <span className="muted">Username</span>
              <code>{issued.username}</code>
            </div>
            <div className="cred-row">
              <span className="muted">Password</span>
              <code>{issued.tempPassword}</code>
            </div>
          </div>
          <p className="field-hint" style={{ marginTop: "0.5rem" }}>
            Give this to the patient directly. They'll be asked to choose their own on first sign-in.
          </p>
        </div>
      )}

      {error && <div className="error-box" style={{ marginTop: "0.7rem" }}>{error}</div>}

      <div className="btn-row" style={{ marginTop: "0.85rem" }}>
        <button onClick={issue} disabled={busy}>
          {busy ? <span className="spinner" /> : null}
          {credentials.hasPassword ? "Reset password" : "Generate password"}
        </button>
      </div>
    </div>
  );
}

export default function Patient() {
  const { id } = useParams();
  const navigate = useNavigate();
  const colors = useThemeColors();

  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.get(`/patients/${id}`));
    } catch (e) {
      setError(e.message);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <main className="page"><div className="error-box">{error}</div></main>;
  if (!data) return <main className="page"><p className="muted">Loading…</p></main>;

  const { patient, partner, points, moodLogs, journals, partnerMoodLogs, partnerJournals, compliance, reports, severityBucket, credentials } = data;

  const generateReport = async () => {
    setGenerating(true);
    setError(null);
    try {
      const { report } = await api.post(`/patients/${patient.id}/reports`);
      navigate(`/reports/${report.id}`);
    } catch (e) {
      setError(e.message);
      setGenerating(false);
    }
  };

  const regenerate = async () => {
    setRegenerating(true);
    try {
      await api.post(`/patients/${patient.id}/regenerate`, {});
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <main className="page">
      <Link to="/" className="back-link">← Back to patients</Link>

      <div className="page-head">
        <div>
          <h1>{patient.name}</h1>
          <p className="page-sub">
            @{patient.username} · {patient.age} years · {patient.email}
            {partner ? ` · observer: ${partner.name}` : ""}
          </p>
          {patient.description && (
            <p className="page-sub" style={{ maxWidth: 680, marginTop: "0.5rem" }}>{patient.description}</p>
          )}
        </div>
        <div className="btn-row">
          <button onClick={regenerate} disabled={regenerating} title="Roll a fresh simulated dataset">
            {regenerating ? <span className="spinner" /> : null} Regenerate data
          </button>
          <button className="btn-primary" onClick={generateReport} disabled={generating}>
            {generating ? <span className="spinner" /> : null}
            {generating ? "Analysing…" : "Generate report"}
          </button>
        </div>
      </div>

      <div className="grid grid-3" style={{ marginBottom: "1rem" }}>
        <StatTile
          label="Baseline health score"
          value={patient.health_score}
          unit="/10"
          foot={bucketLabel[severityBucket]}
          tone={severityBucket === "high" ? "critical" : severityBucket === "stable" ? "good" : undefined}
        />
        <StatTile label="Average mood" value={fmt(mean(points.map((p) => p.mood_score)))} unit="/10" foot={`${points.length} tracked days`} />
        <StatTile label="Average sleep" value={fmt(mean(points.map((p) => p.sleep_hours)))} unit="h" foot={`Quality ${fmt(mean(points.map((p) => p.sleep_quality)), 0)}/100`} />
        <StatTile label="Resting heart rate" value={fmt(mean(points.map((p) => p.resting_hr)), 0)} unit="bpm" foot={`HRV ${fmt(mean(points.map((p) => p.hrv)), 0)}ms`} />
      </div>

      <div className="grid grid-2">
        <div className="stack">
          <div className="card">
            <div className="card-head">
              <span className="card-title">Mood, anxiety and energy</span>
              <span className="card-note">Self-reported, 1–10</span>
            </div>
            <div className="chart-scroll">
              <MoodChart points={points} />
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <span className="card-title">Sleep duration</span>
              <span className="card-note">Hours per night</span>
            </div>
            <div className="chart-scroll">
              <SleepChart points={points} />
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <span className="card-title">Physiological signals</span>
              <span className="card-note">Separate scales, shown separately</span>
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
              <div>
                <p className="card-note">Breathing rate (per min)</p>
                <MetricChart points={points} dataKey="breathing_rate" name="Breathing" unit="/min" color={colors.series1} />
              </div>
              <div>
                <p className="card-note">Sleep quality (0–100)</p>
                <MetricChart points={points} dataKey="sleep_quality" name="Sleep quality" domain={[0, 100]} color={colors.series4} />
              </div>
            </div>
          </div>
        </div>

        <div className="stack">
          <ComplianceCard compliance={compliance} />

          <PatientLogin patientId={patient.id} credentials={credentials} />

          <div className="card">
            <div className="card-head">
              <span className="card-title">Reports</span>
              <span className="card-note">{reports.length} generated</span>
            </div>
            {reports.length === 0 ? (
              <p className="muted" style={{ fontSize: "0.85rem" }}>
                No reports yet. Generate one to get an AI briefing on this window.
              </p>
            ) : (
              reports.map((r) => (
                <Link key={r.id} to={`/reports/${r.id}`} className="patient-row">
                  <div>
                    <div className="patient-name" style={{ fontSize: "0.88rem" }}>
                      {new Date(r.generated_at.replace(" ", "T") + "Z").toLocaleString("en-GB", {
                        day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
                      })}
                    </div>
                    <div className="patient-meta">{r.model_used}</div>
                  </div>
                  <span className="muted">→</span>
                </Link>
              ))
            )}
          </div>

          <div className="card">
            <div className="card-head">
              <span className="card-title">Journal & mood check-ins</span>
              <span className="card-note">{journals.length} entries</span>
            </div>
            <JournalTimeline journals={journals} moodLogs={moodLogs} />
          </div>
        </div>
      </div>

      {partner && (
        <div className="card" style={{ marginTop: "1rem" }}>
          <div className="card-head">
            <span className="card-title">Patient vs {partner.name}</span>
            <span className="card-note">Highlighted rows differ by 3+ points</span>
          </div>
          <div className="chart-scroll" style={{ marginBottom: "1rem" }}>
            <MoodComparisonChart patientLogs={moodLogs} partnerLogs={partnerMoodLogs} partnerName={partner.name} />
          </div>
          <PartnerCompare
            patientMoods={moodLogs}
            partnerMoods={partnerMoodLogs}
            patientJournals={journals}
            partnerJournals={partnerJournals}
            partnerName={partner.name}
          />
        </div>
      )}
    </main>
  );
}

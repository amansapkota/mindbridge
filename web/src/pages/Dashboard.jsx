import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";

const bucketFor = (score) => (score <= 3 ? "high" : score <= 6 ? "moderate" : "stable");
const bucketLabel = { high: "High severity", moderate: "Moderate", stable: "Stable" };

const relativeDate = (iso) => {
  if (!iso) return "No report yet";
  const then = new Date(iso.replace(" ", "T") + "Z");
  const days = Math.floor((Date.now() - then.getTime()) / 86400000);
  if (days <= 0) return "Report today";
  if (days === 1) return "Report yesterday";
  if (days < 30) return `Report ${days} days ago`;
  return `Report ${then.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
};

export default function Dashboard() {
  const [patients, setPatients] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .get("/patients")
      .then((d) => setPatients(d.patients))
      .catch((e) => setError(e.message));
  }, []);

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Patients</h1>
          <p className="page-sub">
            Between-session wellbeing tracking. Review a patient's data, then generate a briefing.
          </p>
        </div>
        <div className="btn-row">
          <Link to="/import" className="btn">
            Import JSON
          </Link>
          <Link to="/patients/new" className="btn btn-primary">
            + New patient
          </Link>
        </div>
      </div>

      {error && <div className="error-box">{error}</div>}

      {!patients && !error && <p className="muted">Loading…</p>}

      {patients && patients.length === 0 && (
        <div className="empty">
          No patients yet. Create one and Mindbridge will generate a 30-day dataset for it automatically.
        </div>
      )}

      {patients && patients.length > 0 && (
        <div className="card">
          {patients.map((p) => {
            const bucket = bucketFor(p.health_score);
            return (
              <Link key={p.id} to={`/patients/${p.id}`} className="patient-row">
                <div>
                  <div className="patient-name">{p.name}</div>
                  <div className="patient-meta">
                    @{p.username} · {p.age} years
                    {p.partner_name ? ` · observer: ${p.partner_name}` : ""} · {relativeDate(p.last_report_at)}
                  </div>
                </div>
                <div className="patient-right">
                  {p.compliance_score != null && (
                    <span className="badge" title="Check-in compliance">
                      {p.compliance_score}% logged
                    </span>
                  )}
                  <span className={`badge badge-${bucket}`}>
                    {bucketLabel[bucket]} · {p.health_score}/10
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </main>
  );
}

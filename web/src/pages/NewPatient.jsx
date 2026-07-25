import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api.js";

const initial = {
  name: "",
  email: "",
  age: "",
  username: "",
  description: "",
  health_score: 5,
  has_partner: false,
  partner_name: "",
};

export default function NewPatient() {
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState([]);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);
  const navigate = useNavigate();

  const set = (key) => (e) => {
    const value = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [key]: value }));
  };

  const submit = async (e) => {
    e.preventDefault();
    setErrors([]);
    setBusy(true);
    try {
      const { patient, credentials } = await api.post("/patients", {
        ...form,
        age: Number(form.age),
        health_score: Number(form.health_score),
      });
      // The temporary password is only ever returned here, so show it before
      // moving on rather than navigating straight to the patient page.
      setCreated({ patient, credentials });
    } catch (err) {
      setErrors(err.details?.length ? err.details : [err.message]);
    } finally {
      setBusy(false);
    }
  };

  const score = Number(form.health_score);
  const bucket = score <= 3 ? "high" : score <= 6 ? "moderate" : "stable";
  const bucketCopy = {
    high: "High severity — disrupted sleep, elevated resting HR, low mood, more missed check-ins.",
    moderate: "Moderate — mixed days, some volatility, mostly consistent logging.",
    stable: "Stable — healthy-range metrics, neutral-to-positive entries, high compliance.",
  };

  if (created) {
    return (
      <main className="page" style={{ maxWidth: 560 }}>
        <div className="page-head">
          <div>
            <h1>{created.patient.name} created</h1>
            <p className="page-sub">A 30-day dataset has been generated and a login issued.</p>
          </div>
        </div>

        <div className="card">
          <div className="notice">
            <strong>Patient login — shown once.</strong>
            <div className="cred-box">
              <div className="cred-row">
                <span className="muted">Username</span>
                <code>{created.credentials.username}</code>
              </div>
              <div className="cred-row">
                <span className="muted">Temporary password</span>
                <code>{created.credentials.tempPassword}</code>
              </div>
            </div>
            <p className="field-hint" style={{ marginTop: "0.5rem" }}>
              The server stores only a hash, so this can't be shown again — but you can issue a new one from
              the patient's page at any time. They'll choose their own password on first sign-in.
            </p>
          </div>

          <div className="btn-row" style={{ marginTop: "1rem" }}>
            <button className="btn-primary" onClick={() => navigate(`/patients/${created.patient.id}`)}>
              Open patient
            </button>
            <button
              onClick={() => {
                setCreated(null);
                setForm(initial);
              }}
            >
              Add another
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="page">
      <Link to="/" className="back-link">
        ← Back to patients
      </Link>
      <div className="page-head">
        <div>
          <h1>New patient</h1>
          <p className="page-sub">
            Saving generates a 30-day simulated dataset — biometrics, EMA check-ins, mood logs and journals.
          </p>
        </div>
      </div>

      <form onSubmit={submit} style={{ maxWidth: 640 }}>
        <div className="card">
          <div className="grid grid-form">
            <div className="field">
              <label htmlFor="name">Full name *</label>
              <input id="name" value={form.name} onChange={set("name")} required />
            </div>
            <div className="field">
              <label htmlFor="email">Email *</label>
              <input id="email" type="email" value={form.email} onChange={set("email")} required />
              <p className="field-hint">Contact only — patients do not log in.</p>
            </div>
            <div className="field">
              <label htmlFor="age">Age *</label>
              <input id="age" type="number" min="1" max="120" value={form.age} onChange={set("age")} required />
            </div>
            <div className="field">
              <label htmlFor="username">Username *</label>
              <input id="username" value={form.username} onChange={set("username")} required />
              <p className="field-hint">Must be unique.</p>
            </div>
          </div>

          <div className="field">
            <label htmlFor="description">General description</label>
            <textarea
              id="description"
              value={form.description}
              onChange={set("description")}
              placeholder="Presenting concerns, relevant history, session cadence…"
            />
            <p className="field-hint">Passed to the model as context, so it calibrates tone and relevance.</p>
          </div>

          <div className="field">
            <label htmlFor="health_score">
              Health score: <strong>{score}</strong> / 10
            </label>
            <input
              id="health_score"
              type="range"
              min="1"
              max="10"
              step="1"
              value={form.health_score}
              onChange={set("health_score")}
            />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem" }} className="muted">
              <span>1 · severe distress</span>
              <span>10 · thriving</span>
            </div>
            <p className="field-hint">
              <span className={`badge badge-${bucket}`}>{bucketCopy[bucket]}</span>
            </p>
          </div>
        </div>

        <div className="card">
          <div className="switch">
            <input id="has_partner" type="checkbox" checked={form.has_partner} onChange={set("has_partner")} />
            <label htmlFor="has_partner" style={{ marginBottom: 0 }}>
              Attach a partner / observer
            </label>
          </div>
          <p className="field-hint" style={{ marginTop: "0.4rem" }}>
            A second person logs mood and journals about the same days from their own point of view. Where the two
            accounts disagree, the report flags it.
          </p>
          {form.has_partner && (
            <div className="field" style={{ marginTop: "0.9rem", maxWidth: 320 }}>
              <label htmlFor="partner_name">Partner name *</label>
              <input id="partner_name" value={form.partner_name} onChange={set("partner_name")} required />
            </div>
          )}
        </div>

        {errors.length > 0 && (
          <div className="error-box" style={{ marginBottom: "1rem" }}>
            <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="btn-row">
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? <span className="spinner" /> : null}
            {busy ? "Creating & generating data…" : "Create patient"}
          </button>
          <Link to="/" className="btn">
            Cancel
          </Link>
        </div>
      </form>
    </main>
  );
}

import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { MetricChart, MoodChart, SleepChart, shortDate, useThemeColors } from "../components/Charts.jsx";
import { JournalTimeline } from "../components/Panels.jsx";

const MOOD_TAGS = ["low", "anxious", "tired", "flat", "ok", "calm", "rested", "motivated", "social", "irritable"];

/**
 * The patient's own view. Deliberately narrower than the clinician's: no health
 * score, no partner stream, no AI report — those are the doctor's framing of the
 * patient, and showing them here would change what the patient reports.
 */
export default function Portal({ session, onRefresh }) {
  const colors = useThemeColors();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [showPasswordForm, setShowPasswordForm] = useState(session.patient.mustChangePassword);

  const load = useCallback(async () => {
    try {
      setData(await api.get("/portal/me"));
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <main className="page"><div className="error-box">{error}</div></main>;
  if (!data) return <main className="page"><p className="muted">Loading…</p></main>;

  const { points, moodLogs, journals, compliance, doctorName } = data;
  const today = new Date().toISOString().slice(0, 10);
  const loggedToday = moodLogs.some((m) => m.date === today);

  return (
    <main className="page" style={{ maxWidth: 960 }}>
      <div className="page-head">
        <div>
          <h1>Hello, {data.patient.name.split(" ")[0]}</h1>
          <p className="page-sub">
            Your check-ins and journal{doctorName ? `, shared with ${doctorName}` : ""}.
          </p>
        </div>
      </div>

      {showPasswordForm && (
        <ChangePassword
          required={session.patient.mustChangePassword}
          onDone={() => {
            setShowPasswordForm(false);
            onRefresh();
          }}
          onCancel={() => setShowPasswordForm(false)}
        />
      )}

      <div className="grid grid-2">
        <div className="stack">
          <CheckIn loggedToday={loggedToday} onSaved={load} />
          <JournalEntryForm onSaved={load} />
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-head">
              <span className="card-title">Your check-ins</span>
              <span className="card-note">
                {compliance.logged} of {compliance.expected} days
              </span>
            </div>
            <div className="meter">
              <div
                className="meter-fill"
                style={{
                  width: `${compliance.score}%`,
                  background: compliance.score >= 85 ? "var(--good)" : compliance.score >= 60 ? "var(--warning)" : "var(--critical)",
                }}
              />
            </div>
            <p className="stat-foot">
              {compliance.score}% logged.{" "}
              {compliance.missedDates.length
                ? `Missed ${compliance.missedDates.length} day${compliance.missedDates.length === 1 ? "" : "s"} — most recently ${shortDate(compliance.missedDates[compliance.missedDates.length - 1])}.`
                : "You haven't missed a day."}
            </p>
          </div>

          {points.length > 0 && (
            <>
              <div className="card">
                <div className="card-head">
                  <span className="card-title">How you've been feeling</span>
                </div>
                <div className="chart-scroll">
                  <MoodChart points={points} />
                </div>
              </div>

              <div className="card">
                <div className="card-head">
                  <span className="card-title">Sleep</span>
                  <span className="card-note">Hours per night</span>
                </div>
                <div className="chart-scroll">
                  <SleepChart points={points} />
                </div>
              </div>

              <div className="card">
                <div className="card-head">
                  <span className="card-title">Resting heart rate</span>
                </div>
                <MetricChart points={points} dataKey="resting_hr" name="Resting HR" unit="bpm" color={colors.series2} />
              </div>
            </>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: "1rem" }}>
        <div className="card-head">
          <span className="card-title">Your journal</span>
          <span className="card-note">{journals.length} entries</span>
        </div>
        <JournalTimeline
          journals={journals}
          moodLogs={moodLogs}
          emptyText="Nothing written yet — your first entry can be a sentence."
        />
      </div>

      <p className="disclaimer">
        Your clinician can see everything on this page. If you're in crisis, contact your local emergency
        services or crisis line — this app is not monitored in real time.{" "}
        <button className="link-btn" onClick={() => setShowPasswordForm(true)}>
          Change password
        </button>
      </p>
    </main>
  );
}

function CheckIn({ loggedToday, onSaved }) {
  const [rating, setRating] = useState(5);
  const [tags, setTags] = useState([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);

  const toggle = (tag) => setTags((t) => (t.includes(tag) ? t.filter((x) => x !== tag) : t.length < 4 ? [...t, tag] : t));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/portal/mood", { mood_rating: rating, tags });
      setDone(true);
      await onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Today's check-in</span>
        {loggedToday && !done && <span className="card-note">already logged — saving again replaces it</span>}
      </div>

      <form onSubmit={submit}>
        <label htmlFor="rating">
          How are you feeling? <strong>{rating}</strong> / 10
        </label>
        <input id="rating" type="range" min="1" max="10" value={rating} onChange={(e) => setRating(Number(e.target.value))} />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem" }} className="muted">
          <span>1 · very low</span>
          <span>10 · very good</span>
        </div>

        <p className="field-hint" style={{ marginTop: "0.75rem", marginBottom: "0.35rem" }}>
          Add up to four words (optional)
        </p>
        <div className="tag-row">
          {MOOD_TAGS.map((tag) => (
            <button
              type="button"
              key={tag}
              onClick={() => toggle(tag)}
              className={`tag tag-button ${tags.includes(tag) ? "tag-selected" : ""}`}
            >
              {tag}
            </button>
          ))}
        </div>

        {error && <div className="error-box" style={{ marginTop: "0.75rem" }}>{error}</div>}

        <div className="btn-row" style={{ marginTop: "1rem" }}>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? <span className="spinner" /> : null} {done ? "Saved — update" : "Save check-in"}
          </button>
        </div>
      </form>
    </div>
  );
}

function JournalEntryForm({ onSaved }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/portal/journal", { text });
      setText("");
      await onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Write something</span>
        <span className="card-note">{text.trim() ? `${text.trim().length} characters` : "optional"}</span>
      </div>
      <form onSubmit={submit}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="However the day went — a sentence is enough."
          style={{ minHeight: 120 }}
        />
        {error && <div className="error-box" style={{ marginTop: "0.75rem" }}>{error}</div>}
        <div className="btn-row" style={{ marginTop: "0.75rem" }}>
          <button type="submit" disabled={busy || !text.trim()}>
            {busy ? <span className="spinner" /> : null} Add entry
          </button>
        </div>
      </form>
    </div>
  );
}

function ChangePassword({ required, onDone, onCancel }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (newPassword !== confirm) return setError("The two new passwords don't match");
    setBusy(true);
    setError(null);
    try {
      await api.post("/auth/change-password", { currentPassword, newPassword });
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: "1rem" }}>
      <div className="card-head">
        <span className="card-title">{required ? "Choose your own password" : "Change password"}</span>
        {required && <span className="card-note">you're using a temporary one</span>}
      </div>
      <form onSubmit={submit} style={{ maxWidth: 360 }}>
        <div className="field">
          <label htmlFor="cur">Current password</label>
          <input id="cur" type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="new">New password</label>
          <input id="new" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required minLength={8} />
          <p className="field-hint">At least 8 characters.</p>
        </div>
        <div className="field">
          <label htmlFor="conf">Confirm new password</label>
          <input id="conf" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </div>
        {error && <div className="error-box" style={{ marginBottom: "0.75rem" }}>{error}</div>}
        <div className="btn-row">
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? <span className="spinner" /> : null} Save password
          </button>
          {!required && <button type="button" onClick={onCancel}>Cancel</button>}
        </div>
      </form>
    </div>
  );
}

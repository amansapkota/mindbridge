import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";

const SECTION_LABELS = { dataPoints: "Daily data", moodLogs: "Mood logs", journals: "Journals" };

const ACTION_BADGE = {
  match: { className: "badge badge-stable", text: "Update existing" },
  create: { className: "badge badge-moderate", text: "Create new" },
  error: { className: "badge badge-high", text: "Blocked" },
};

export default function Import() {
  const [text, setText] = useState("");
  const [filename, setFilename] = useState(null);
  const [createMissing, setCreateMissing] = useState(false);
  const [plan, setPlan] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [history, setHistory] = useState([]);
  const fileRef = useRef(null);

  const loadHistory = useCallback(() => {
    api.get("/import/history").then((d) => setHistory(d.batches)).catch(() => {});
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // Any edit invalidates a plan built from the previous text.
  const updateText = (value, name = null) => {
    setText(value);
    setFilename(name);
    setPlan(null);
    setResult(null);
    setError(null);
  };

  const readFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => updateText(String(reader.result), file.name);
    reader.onerror = () => setError(`Could not read ${file.name}`);
    reader.readAsText(file);
  };

  const parsed = () => {
    try {
      return { document: JSON.parse(text) };
    } catch (e) {
      return { parseError: e.message };
    }
  };

  const validate = async () => {
    const { document, parseError } = parsed();
    if (parseError) return setError(`That isn't valid JSON — ${parseError}`);

    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.post("/import/validate", {
        document,
        options: { createMissingPatients: createMissing },
      });
      setPlan(res.plan);
    } catch (e) {
      setError(e.message);
      setPlan(null);
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    const { document, parseError } = parsed();
    if (parseError) return setError(`That isn't valid JSON — ${parseError}`);

    setBusy(true);
    setError(null);
    try {
      const res = await api.post("/import/commit", {
        document,
        filename,
        options: { createMissingPatients: createMissing },
      });
      setResult(res);
      setPlan(null);
      loadHistory();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const loadTemplate = async () => {
    const template = await api.get("/import/template");
    updateText(JSON.stringify(template, null, 2), "template.json");
  };

  const downloadTemplate = async () => {
    const template = await api.get("/import/template");
    const blob = new Blob([JSON.stringify(template, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "mindbridge-import-template.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main className="page">
      <Link to="/" className="back-link">← Back to patients</Link>

      <div className="page-head">
        <div>
          <h1>Import JSON</h1>
          <p className="page-sub">
            Load real or externally-exported data for your patients. Nothing is written until you review the
            preview and commit.
          </p>
        </div>
        <div className="btn-row">
          <button onClick={loadTemplate}>Load example</button>
          <button onClick={downloadTemplate}>Download template</button>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="stack">
          {/* ---------- input ---------- */}
          <div className="card">
            <div className="card-head">
              <span className="card-title">1 · Paste or drop a file</span>
              {filename && <span className="card-note">{filename}</span>}
            </div>

            <div
              className={`dropzone ${dragging ? "dropzone-active" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                readFile(e.dataTransfer.files?.[0]);
              }}
              onClick={() => fileRef.current?.click()}
            >
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                style={{ display: "none" }}
                onChange={(e) => readFile(e.target.files?.[0])}
              />
              Drop a <code>.json</code> file here, or click to choose one
            </div>

            <textarea
              value={text}
              onChange={(e) => updateText(e.target.value, filename)}
              placeholder='{ "format": "mindbridge.v1", "patients": [ … ] }'
              style={{ marginTop: "0.75rem", minHeight: 220, fontFamily: "ui-monospace, monospace", fontSize: "0.8rem" }}
            />

            <div className="switch" style={{ marginTop: "0.85rem" }}>
              <input
                id="createMissing"
                type="checkbox"
                checked={createMissing}
                onChange={(e) => {
                  setCreateMissing(e.target.checked);
                  setPlan(null);
                }}
              />
              <label htmlFor="createMissing" style={{ marginBottom: 0 }}>
                Create missing patients
              </label>
            </div>
            <p className="field-hint">
              Off by default, so a typo in a username fails loudly instead of quietly creating a duplicate
              patient record. New patients get a login automatically.
            </p>

            {error && <div className="error-box" style={{ marginTop: "0.85rem" }}>{error}</div>}

            <div className="btn-row" style={{ marginTop: "1rem" }}>
              <button onClick={validate} disabled={busy || !text.trim()}>
                {busy && !plan ? <span className="spinner" /> : null} Validate
              </button>
              <button className="btn-primary" onClick={commit} disabled={busy || !plan?.importable}>
                {busy && plan ? <span className="spinner" /> : null} Commit import
              </button>
            </div>
            {plan && !plan.importable && (
              <p className="field-hint" style={{ color: "var(--critical)" }}>
                Every entry is blocked — fix the errors below before committing.
              </p>
            )}
          </div>

          {/* ---------- format help ---------- */}
          <div className="card">
            <div className="card-head">
              <span className="card-title">Format</span>
              <span className="card-note">mindbridge.v1</span>
            </div>
            <p className="entry-text" style={{ marginBottom: "0.6rem" }}>
              A file is <code>{"{ patients: [ … ] }"}</code>, a bare array of patient entries, or a single entry.
              Each entry can carry any combination of these:
            </p>
            <ul className="entry-text" style={{ margin: 0, paddingLeft: "1.1rem" }}>
              <li>
                <code>match</code> — <code>username</code>, <code>email</code> or <code>patientId</code>, tried in
                that order
              </li>
              <li>
                <code>demographics</code> — name, email, age, description, health_score, partner_name
              </li>
              <li>
                <code>dataPoints[]</code> — date + any of sleep_hours, sleep_quality, resting_hr, hrv,
                breathing_rate, mood_score, anxiety_score, energy_score
              </li>
              <li>
                <code>moodLogs[]</code> — date, author (patient/partner), mood_rating 1–10, tags[]
              </li>
              <li>
                <code>journals[]</code> — date, author, text
              </li>
            </ul>
            <p className="field-hint" style={{ marginTop: "0.6rem" }}>
              Dates accept <code>YYYY-MM-DD</code>, full ISO or epoch milliseconds. Numbers may be strings.
              Re-importing the same date replaces that day rather than duplicating it, so a corrected file can
              simply be uploaded again.
            </p>
          </div>
        </div>

        <div className="stack">
          {/* ---------- preview ---------- */}
          {plan && (
            <div className="card">
              <div className="card-head">
                <span className="card-title">2 · Preview</span>
                <span className="card-note">nothing written yet</span>
              </div>

              <div className="grid grid-3" style={{ marginBottom: "0.9rem" }}>
                <div>
                  <div className="stat-label">Patients</div>
                  <div className="stat-value" style={{ fontSize: "1.35rem" }}>{plan.totals.patients}</div>
                  <div className="stat-foot">
                    {plan.totals.toCreate} new · {plan.totals.toMatch} existing
                  </div>
                </div>
                <div>
                  <div className="stat-label">Rows to import</div>
                  <div className="stat-value" style={{ fontSize: "1.35rem" }}>
                    {Object.values(plan.totals.accepted).reduce((a, b) => a + b, 0)}
                  </div>
                  <div className="stat-foot">
                    {Object.entries(plan.totals.accepted).map(([k, v]) => `${v} ${SECTION_LABELS[k].toLowerCase()}`).join(" · ")}
                  </div>
                </div>
                <div>
                  <div className="stat-label">Problems</div>
                  <div
                    className="stat-value"
                    style={{ fontSize: "1.35rem", color: plan.totals.errors ? "var(--critical)" : "var(--text-primary)" }}
                  >
                    {plan.totals.errors + plan.totals.warnings}
                  </div>
                  <div className="stat-foot">
                    {plan.totals.errors} blocking · {plan.totals.warnings} skipped rows
                  </div>
                </div>
              </div>

              {plan.bundles.map((b) => {
                const badge = ACTION_BADGE[b.action];
                return (
                  <div className="insight" key={b.index}>
                    <div className="insight-title" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      {b.label}
                      <span className={badge.className}>{badge.text}</span>
                    </div>
                    <p className="insight-detail">
                      {Object.entries(b.accepted)
                        .filter(([, v]) => v > 0)
                        .map(([k, v]) => `${v} ${SECTION_LABELS[k].toLowerCase()}`)
                        .join(", ") || "no rows"}
                      {b.dateRange ? ` · ${b.dateRange.from} → ${b.dateRange.to}` : ""}
                    </p>

                    {b.errors.map((e, i) => (
                      <p key={`e${i}`} className="insight-evidence" style={{ color: "var(--critical)" }}>
                        <strong>{e.path}</strong> — {e.message}
                      </p>
                    ))}
                    {b.warnings.slice(0, 6).map((w, i) => (
                      <p key={`w${i}`} className="insight-evidence">
                        skipped · <strong>{w.path}</strong> — {w.message}
                      </p>
                    ))}
                    {b.warnings.length > 6 && (
                      <p className="insight-evidence">…and {b.warnings.length - 6} more skipped rows</p>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* ---------- result ---------- */}
          {result && (
            <div className="card">
              <div className="card-head">
                <span className="card-title">Import complete</span>
                <span className="card-note">batch #{result.batchId}</span>
              </div>
              <p className="entry-text">
                {result.recordsImported} record{result.recordsImported === 1 ? "" : "s"} imported ·{" "}
                {result.patientsCreated} patient{result.patientsCreated === 1 ? "" : "s"} created ·{" "}
                {result.patientsMatched} updated
                {result.recordsSkipped ? ` · ${result.recordsSkipped} rows skipped` : ""}
              </p>

              {result.createdCredentials.length > 0 && (
                <div className="notice" style={{ marginTop: "0.85rem" }}>
                  <strong>Logins for the new patients — shown once.</strong>
                  <table className="cred-table">
                    <thead>
                      <tr>
                        <th>Patient</th>
                        <th>Username</th>
                        <th>Temporary password</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.createdCredentials.map((c) => (
                        <tr key={c.patientId}>
                          <td>{c.name}</td>
                          <td><code>{c.username}</code></td>
                          <td><code>{c.tempPassword}</code></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="btn-row" style={{ marginTop: "0.85rem" }}>
                <Link to="/" className="btn">Back to patients</Link>
              </div>
            </div>
          )}

          {/* ---------- history ---------- */}
          <div className="card">
            <div className="card-head">
              <span className="card-title">Import history</span>
              <span className="card-note">{history.length} batches</span>
            </div>
            {history.length === 0 ? (
              <p className="muted" style={{ fontSize: "0.85rem" }}>No imports yet.</p>
            ) : (
              history.map((b) => (
                <div className="insight" key={b.id}>
                  <div className="insight-title" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    {b.filename || "pasted JSON"}
                    {b.status === "reverted" && <span className="badge">reverted</span>}
                  </div>
                  <p className="insight-detail">
                    {b.records_imported} records · {b.patients_created} created · {b.patients_matched} updated
                  </p>
                  <p className="insight-evidence">
                    {new Date(b.created_at.replace(" ", "T") + "Z").toLocaleString("en-GB")}
                    {b.status !== "reverted" && (
                      <>
                        {" · "}
                        <button
                          className="link-btn"
                          onClick={async () => {
                            await api.post(`/import/batches/${b.id}/revert`);
                            loadHistory();
                          }}
                        >
                          revert
                        </button>
                      </>
                    )}
                  </p>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

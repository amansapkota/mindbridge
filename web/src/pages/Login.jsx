import { useState } from "react";
import { api, setToken } from "../api.js";

export default function Login({ onSignedIn }) {
  const [username, setUsername] = useState("drsmith");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { token } = await api.post("/auth/login", { username, password });
      setToken(token);
      await onSignedIn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="card login-card">
        <div style={{ textAlign: "center", marginBottom: "1.5rem" }}>
          <div className="brand" style={{ justifyContent: "center", fontSize: "1.15rem" }}>
            <span className="brand-mark">M</span> Mindbridge
          </div>
          <p className="page-sub">Sign in</p>
        </div>

        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="username">Username</label>
            <input id="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>

          {error && <div className="error-box" style={{ marginBottom: "1rem" }}>{error}</div>}

          <button type="submit" className="btn-primary" style={{ width: "100%", justifyContent: "center" }} disabled={busy}>
            {busy ? <span className="spinner" /> : "Sign in"}
          </button>
        </form>

        <p className="field-hint" style={{ marginTop: "1rem", textAlign: "center" }}>
          Clinicians and patients sign in here — the same form routes you to the right view.
          <br />
          Prototype clinician: <code>drsmith</code> / <code>mindbridge</code>
          <br />
          Patient logins are issued by your clinician.
        </p>
      </div>
    </div>
  );
}

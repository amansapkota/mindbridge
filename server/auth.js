import crypto from "node:crypto";
import { db } from "./db.js";

/**
 * Login for both roles.
 *
 * Doctors were the only account type in the original prototype scope. Patient
 * login was added afterwards on request: a patient signs in with the username
 * the doctor already assigned them, using a password the doctor generates. A
 * patient only ever sees their own record.
 *
 * Sessions are opaque bearer tokens held in memory — a server restart logs
 * everyone out. Fine for a prototype, and the first thing to replace.
 *
 * MINDBRIDGE_NO_AUTH=1 bypasses login and runs as the seeded doctor.
 */

const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const sessions = new Map(); // token -> { role, doctorId?, patientId?, expiresAt }

const DEFAULT_PASSWORD = process.env.MINDBRIDGE_DOCTOR_PASSWORD || "mindbridge";

export function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, expected] = stored.split(":");
  const actual = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(actual, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Readable temporary password — avoids look-alike characters so it survives
 * being read aloud or written on a card in a session.
 */
export function generateTempPassword() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(10);
  let out = "";
  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 7) out += "-";
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function pruneSessions() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
}

function issueToken(session) {
  pruneSessions();
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { ...session, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

function readToken(req) {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : null;
}

export function attachAuth(app) {
  // Give the seeded doctor a usable password on first boot.
  const doctor = db.prepare("SELECT * FROM doctors WHERE username = ?").get("drsmith");
  if (doctor && !doctor.password_hash) {
    db.prepare("UPDATE doctors SET password_hash = ? WHERE id = ?").run(hashPassword(DEFAULT_PASSWORD), doctor.id);
    console.log(`Seeded doctor login — username: drsmith  password: ${DEFAULT_PASSWORD}`);
  }

  app.post("/api/auth/login", (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "Username and password are required" });

    const name = String(username).trim();

    // Doctors first, then patients. Usernames are unique within each table; a
    // collision across tables resolves to the doctor, which is the safer default.
    const doctorRow = db.prepare("SELECT * FROM doctors WHERE username = ?").get(name);
    if (doctorRow && verifyPassword(String(password), doctorRow.password_hash)) {
      const token = issueToken({ role: "doctor", doctorId: doctorRow.id });
      return res.json({
        token,
        role: "doctor",
        doctor: { id: doctorRow.id, name: doctorRow.name, email: doctorRow.email, username: doctorRow.username },
      });
    }

    const patientRow = db.prepare("SELECT * FROM patients WHERE username = ?").get(name);
    if (patientRow?.password_hash && verifyPassword(String(password), patientRow.password_hash)) {
      db.prepare("UPDATE patients SET last_login_at = datetime('now') WHERE id = ?").run(patientRow.id);
      const token = issueToken({ role: "patient", patientId: patientRow.id });
      return res.json({
        token,
        role: "patient",
        patient: {
          id: patientRow.id,
          name: patientRow.name,
          username: patientRow.username,
          mustChangePassword: Boolean(patientRow.must_change_password),
        },
      });
    }

    res.status(401).json({ error: "Incorrect username or password" });
  });

  app.post("/api/auth/logout", (req, res) => {
    const token = readToken(req);
    if (token) sessions.delete(token);
    res.json({ ok: true });
  });

  /** Patients change their own temporary password. */
  app.post("/api/auth/change-password", requirePatient, (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 8) {
      return res.status(400).json({ error: "New password must be at least 8 characters" });
    }

    const row = db.prepare("SELECT * FROM patients WHERE id = ?").get(req.patient.id);
    if (!verifyPassword(String(currentPassword || ""), row.password_hash)) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }

    db.prepare("UPDATE patients SET password_hash = ?, must_change_password = 0 WHERE id = ?").run(
      hashPassword(String(newPassword)),
      row.id
    );
    res.json({ ok: true });
  });
}

function resolveSession(req) {
  if (process.env.MINDBRIDGE_NO_AUTH === "1") {
    const doctor = db.prepare("SELECT * FROM doctors WHERE username = ?").get("drsmith");
    return doctor ? { role: "doctor", doctorId: doctor.id } : null;
  }
  const token = readToken(req);
  const session = token ? sessions.get(token) : null;
  if (!session || session.expiresAt <= Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  return session;
}

export function requireDoctor(req, res, next) {
  const session = resolveSession(req);
  if (!session) return res.status(401).json({ error: "Session expired — please sign in again" });
  if (session.role !== "doctor") return res.status(403).json({ error: "This area is for clinicians" });

  req.doctor = db.prepare("SELECT * FROM doctors WHERE id = ?").get(session.doctorId);
  if (!req.doctor) return res.status(401).json({ error: "Session no longer valid" });
  next();
}

export function requirePatient(req, res, next) {
  const session = resolveSession(req);
  if (!session) return res.status(401).json({ error: "Session expired — please sign in again" });
  if (session.role !== "patient") return res.status(403).json({ error: "This area is for patients" });

  req.patient = db.prepare("SELECT * FROM patients WHERE id = ?").get(session.patientId);
  if (!req.patient) return res.status(401).json({ error: "Session no longer valid" });
  next();
}

/** Either role — used by /api/me so the client can route by role. */
export function requireAnyone(req, res, next) {
  const session = resolveSession(req);
  if (!session) return res.status(401).json({ error: "Session expired — please sign in again" });

  req.session = session;
  if (session.role === "doctor") req.doctor = db.prepare("SELECT * FROM doctors WHERE id = ?").get(session.doctorId);
  else req.patient = db.prepare("SELECT * FROM patients WHERE id = ?").get(session.patientId);
  next();
}

/** Doctor sets or resets a patient's password; the plaintext is returned once. */
export function setPatientPassword(patientId, password, mustChange = true) {
  const temp = password || generateTempPassword();
  db.prepare("UPDATE patients SET password_hash = ?, must_change_password = ? WHERE id = ?").run(
    hashPassword(temp),
    mustChange ? 1 : 0,
    patientId
  );
  return temp;
}

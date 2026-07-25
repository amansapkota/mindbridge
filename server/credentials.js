/**
 * Patient login helper.
 *
 *   node credentials.js            list every patient and whether they have a login
 *   node credentials.js --issue    generate a password for anyone without one
 *   node credentials.js --reset-all  issue a fresh password for every patient
 *   node credentials.js danielo    reset one patient by username
 *
 * Passwords are printed once here and stored as a scrypt hash — there is no way
 * to read them back afterwards, by design. Re-run with a username to reissue.
 */
import { db } from "./db.js";
import { setPatientPassword } from "./auth.js";

const args = process.argv.slice(2);
const issue = args.includes("--issue");
const resetAll = args.includes("--reset-all");
const usernames = args.filter((a) => !a.startsWith("--"));

const patients = db
  .prepare("SELECT id, name, username, password_hash, must_change_password, last_login_at FROM patients ORDER BY id")
  .all();

if (patients.length === 0) {
  console.log("No patients yet. Create one in the app, or run `npm run seed`.");
  process.exit(0);
}

const issued = [];

for (const p of patients) {
  const targeted = usernames.includes(p.username);
  const needsOne = issue && !p.password_hash;
  if (targeted || needsOne || resetAll) {
    issued.push({ ...p, tempPassword: setPatientPassword(p.id, null, true) });
  }
}

if (usernames.length) {
  const unknown = usernames.filter((u) => !patients.some((p) => p.username === u));
  for (const u of unknown) console.log(`No patient with username "${u}"`);
}

const pad = (s, n) => String(s).padEnd(n);
console.log("");
console.log(pad("PATIENT", 22) + pad("USERNAME", 16) + pad("PASSWORD", 16) + "STATUS");
console.log("-".repeat(70));

for (const p of patients) {
  const fresh = issued.find((i) => i.id === p.id);
  const status = fresh
    ? "new — must change on first sign-in"
    : p.password_hash
      ? p.must_change_password
        ? "set (temporary, unchanged)"
        : "set (chosen by patient)"
      : "no login";
  console.log(pad(p.name, 22) + pad(p.username, 16) + pad(fresh ? fresh.tempPassword : "—", 16) + status);
}

console.log("");
if (!issue && !resetAll && !usernames.length) {
  console.log("Passwords are shown only when issued. Run with --issue to create logins for");
  console.log("anyone without one, or pass a username to reset a specific patient.");
} else {
  console.log(`Issued ${issued.length} password${issued.length === 1 ? "" : "s"}. Give these to the patients directly.`);
}

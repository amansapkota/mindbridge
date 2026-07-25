# Mindbridge — prototype

AI-assisted between-session wellbeing tracking for psychiatrists and therapists.
Doctor-only, with simulated patient data. Built to validate one loop:

**create patient → generate fake data → send to AI → show report.**

## Run it

Two terminals:

```bash
cd server && npm install && npm start     # http://localhost:4100
cd web    && npm install && npm run dev   # http://localhost:5180
```

Sign in as **`drsmith` / `mindbridge`**.

Optional demo patients across the severity range:

```bash
cd server && npm run seed
```

## Logins

One sign-in form serves both roles and routes you to the right view.

**Clinician** — `drsmith` / `mindbridge` (override with `MINDBRIDGE_DOCTOR_PASSWORD`).

**Patients** get a login automatically when they are created, whether through the form
or through a JSON import. The temporary password is shown **once**, immediately after
creation — the server stores only a scrypt hash and cannot show it again. You can always
issue a new one from the patient's page ("Reset password"), or from the CLI:

```bash
cd server
npm run credentials              # who has a login, and who doesn't
npm run credentials -- --issue   # generate one for anyone without
npm run credentials -- danielo   # reset a specific patient
```

A patient signing in with a temporary password is asked to choose their own before
anything else.

### What a patient sees

Deliberately narrower than the clinician's view: their own check-ins, journal, sleep and
heart-rate charts, and their compliance. They do **not** see their health score, the
partner/observer stream, or any AI report — those are the clinician's framing of the
patient, and showing them would change what the patient reports. They can log a daily
mood check-in (one per day; re-saving replaces it) and write journal entries, both of
which flow straight into the clinician's view and the next report.

> Note: the original PRD put patient login out of scope. This was added on request and
> goes beyond that scope — the data model reserved for it, but nothing else did.

## Importing JSON

**Patients → Import JSON.** Paste or drop a `.json` file, hit **Validate** for a dry run,
then **Commit**. Nothing is written until you commit.

The format (`mindbridge.v1`) is documented in-app on the import page, and
**Download template** gives you a valid, fully-populated example. A file is
`{ patients: [ … ] }`, a bare array, or a single entry. Each entry may carry:

| Key | Notes |
|---|---|
| `match` | `username`, `email` or `patientId` — tried in that order |
| `demographics` | name, email, age, description, health_score, partner_name |
| `dataPoints[]` | date + any of sleep_hours, sleep_quality, resting_hr, hrv, breathing_rate, mood_score, anxiety_score, energy_score |
| `moodLogs[]` | date, author (`patient`/`partner`), mood_rating 1–10, tags[] |
| `journals[]` | date, author, text |

Behaviour worth knowing:

- **One bad row doesn't sink the file.** Each row is validated on its own; invalid ones
  are reported with their exact path (`patients[0].dataPoints[2].date`) and skipped, and
  the rest import. Blocking problems are per-patient and are listed separately.
- **Re-importing is safe.** A `dataPoint` or `moodLog` for a date already present
  replaces it rather than stacking a duplicate. Journals dedupe on identical text, so
  genuinely distinct same-day entries both survive but re-uploading the same file
  doesn't create copies.
- **Creating patients is opt-in.** "Create missing patients" is off by default, so a typo
  in a username fails loudly instead of quietly creating a duplicate record. New patients
  get a login, shown once in the result panel.
- **Forgiving inputs.** Dates accept `YYYY-MM-DD`, full ISO or epoch ms; numbers may
  arrive as strings.
- **Imports can be reverted** from the history panel, which removes every row that batch
  wrote. Patients it created are left in place.

Imported rows are marked `source = 'imported'` so they stay distinguishable from
generated and self-reported data, and compliance is recalculated after every import.

## AI configuration

Report generation calls an OpenAI-compatible chat-completions endpoint:

```bash
MINDBRIDGE_API_KEY=sk-...              # or OPENAI_API_KEY
MINDBRIDGE_MODEL=gpt-4o-mini           # default
MINDBRIDGE_BASE_URL=https://api.openai.com/v1
```

Because it is OpenAI-compatible, pointing `MINDBRIDGE_BASE_URL` at OpenRouter or a
Gemini compatibility endpoint works without code changes — there is deliberately no
model-swap abstraction layer beyond that.

**With no key set**, reports come from a local analysis pass instead (trends, Pearson
correlations, worst-burden days, partner mismatches, compliance gaps). It is derived
from the patient's actual data rather than canned text, and every report records which
path produced it. This keeps the loop demoable offline; it is not a substitute for
validating the real prompt.

### De-risking the prompt

The main risk is generic output. `try-prompt.js` runs the real prompt against fresh
datasets with no database or UI involved:

```bash
cd server
node try-prompt.js              # severities 2, 5, 9
node try-prompt.js 3            # one severity
node try-prompt.js 3 --print    # dump the prompt instead of calling the model
```

Do this before trusting the dashboard.

## How it is put together

```
server/
  db.js            SQLite schema — PRD section 7, plus later columns via ensureColumn
  generator.js     the simulated data engine (the interesting part)
  snippets.json    hand-written journal pool, bucketed by severity/theme/perspective
  ai.js            prompt, provider call, keyword guardrail, offline fallback
  import.js        mindbridge.v1 validation, commit, revert, template
  onePager.js      condenses a saved report — no second AI call
  auth.js          doctor + patient login, scrypt, in-memory bearer sessions
  credentials.js   CLI for issuing and resetting patient logins
  index.js         routes
web/
  src/pages/       Login, Dashboard, NewPatient, Patient, Report, OnePager,
                   Import (doctor), Portal (patient)
  src/components/  Charts (Recharts), Panels (timeline, compare, compliance)
```

Schema changes after the initial build are applied by `ensureColumn` in `db.js` — it
checks `pragma table_info` first, since SQLite has no `ADD COLUMN IF NOT EXISTS`. An
existing database picks them up on next boot; no migration step to run.

Storage is `node:sqlite` (built into Node 22+), so there are no native dependencies and
no database server to run. The file lives at `server/data/mindbridge.db`.

### The data generator

`generateTimeseries(healthScore, days = 30, seed)` produces 30 days of sleep, resting
HR, HRV, breathing rate and EMA mood/anxiety/energy.

- Three documented severity bands (`SEVERITY_BANDS` in `generator.js`) anchor health
  scores 1, 5.5 and 10. A patient's actual score is **interpolated** between the two
  nearest anchors, so score 4 sits between bands rather than snapping to one.
- Gaussian noise per metric, plus randomly placed **spike days** pushed 1.5–2.5 SD in
  whichever direction is worse for that metric.
- Some days are **skipped entirely**, which is what gives the compliance score (PRD 6.5)
  something real to measure.
- Journals are drawn from `snippets.json`, weighted by distance from the patient's own
  severity band — a spike day shifts one band worse rather than jumping to the most
  severe pool, so a thriving patient has an off day rather than a crisis. Measured over
  12 datasets each: health 2 → 76% high-severity entries, health 5 → 47% moderate,
  health 9 → 74% stable.
- Seeded RNG, so a dataset is reproducible when comparing prompt changes. "Regenerate
  data" rolls a new seed.

### Partner / observer

When a partner is attached, their severity is **rolled separately** — roughly half the
time it tracks the patient, otherwise it diverges by 2–4 points. That offset shifts
their mood ratings *and* their snippet pool together, so the numbers and the text tell
the same story. Days where the two accounts differ by 3+ points are highlighted in the
UI and called out in the report. In testing, a divergent roll produces mismatch days in
about half of generated datasets.

### Guardrail

`runGuardrail()` greps the model's output for diagnostic language (`diagnos-`, disorder
names, prescribing verbs). It is a cheap check, not a safety system: a flagged report is
still saved and shown, with a banner naming the matched wording. The primary control is
the system prompt.

The report UI distinguishes AI interpretation (purple-edged blocks, "AI INTERPRETATION")
from recorded data (unmarked panels, "RECORDED DATA"), per PRD 6.7.

## Deliberately not built

Per the agreed prototype scope: no real device/EMA integration, no multi-doctor
permissions, no PDF library (the one-page summary is a print stylesheet — use the
browser's Save as PDF). The patient-facing side is intentionally minimal: check-in,
journal, own charts, nothing else.

## Known limitations

- Sessions are in-memory, so restarting the server signs everyone out.
- The single doctor is seeded on first boot; there is no registration flow.
- If a doctor and a patient ever share a username, login resolves to the doctor.
- Patient passwords have no rate limiting, lockout or reset-by-email — a clinician
  reissues them by hand.
- The offline fallback is not a stand-in for prompt validation — see above.
- Passwords are scrypt-hashed but there is no rate limiting or lockout.
- Reports snapshot the data they analysed, so a saved report stays meaningful after
  "Regenerate data" replaces the live dataset. This makes the `reports` table grow
  faster than it otherwise would.
"# mindbridge" 

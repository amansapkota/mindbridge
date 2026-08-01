# Mindbridge — prototype

AI-assisted between-session wellbeing tracking for psychiatrists and therapists.
Clinician-led. Built to validate one loop:

**patient logs check-ins → send to AI → show report.**

## Where a patient's data comes from

A new patient starts **empty**. Their record fills up from two real sources:

- **the patient themselves**, signing in to the portal to log a daily mood check-in and
  write journal entries (`source = 'self-reported'`)
- **JSON import**, for data produced by another system (`source = 'imported'`)

There is also a **simulated data generator**, which is what the original prototype used
to demonstrate the report loop before any real data existed. It is still there, but it
is no longer wired to patient creation — it only runs when a clinician explicitly clicks
**"Regenerate data"**, and everything it writes is tagged `source = 'generated'` so it
stays distinguishable from the real thing. Its journal text is drawn from a fixed pool of
48 hand-written snippets in `snippets.json`, so it repeats itself over a 30-day window;
that is expected, and it is a good reminder that those rows are not evidence about a
patient.

If you want to know whether a given row is real, ask the database:

```sql
SELECT source, COUNT(*) FROM mb_journal_entries WHERE patient_id = ? GROUP BY source;
```

## Run it

Configuration first — the server needs a MySQL database and, for live reports, an
API key:

```bash
cd server && cp .env.example .env   # then fill it in
```

Then two terminals:

```bash
cd server && npm install && npm start     # http://localhost:4100
cd web    && npm install && npm run dev   # http://localhost:5180
```

The server creates its own tables on boot and prints what it connected to:

```
Mindbridge API on http://localhost:4100
DB: u1_nikas@110.34.1.161 (tables prefixed "mb_")
AI: nvidia/nemotron-3-super-120b-a12b:free via https://openrouter.ai/api/v1
```

Sign in as **`drsmith` / `mindbridge`**.

Optional demo patients across the severity range — note that these are **generated**,
not real, and exist so there is something to show the report loop against:

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

Report generation calls an OpenAI-compatible chat-completions endpoint. It currently
points at OpenRouter:

```bash
MINDBRIDGE_API_KEY=sk-or-v1-...        # or OPENAI_API_KEY
MINDBRIDGE_BASE_URL=https://openrouter.ai/api/v1
MINDBRIDGE_MODEL=nvidia/nemotron-3-super-120b-a12b:free
MINDBRIDGE_FALLBACK_MODELS=openrouter/free,openai/gpt-oss-20b:free
MINDBRIDGE_MODEL_TIMEOUT_MS=90000
```

Because it is OpenAI-compatible, pointing `MINDBRIDGE_BASE_URL` at OpenAI or a Gemini
compatibility endpoint works without code changes — there is deliberately no model-swap
abstraction layer beyond that.

`MINDBRIDGE_FALLBACK_MODELS` is the one concession to running on free-tier capacity.
Those endpoints return 429 from the upstream provider often enough that a single model
would drop the clinician into the offline path mid-session for no good reason, so each
candidate is tried in order with the same prompt and whichever answers is recorded as
the report's `model_used`. `MINDBRIDGE_MODEL_TIMEOUT_MS` caps each attempt, because a
queued free endpoint can otherwise sit open for minutes.

Free-tier latency is genuinely variable — the same call has returned in 1 second and in
100. Expect report generation to take anywhere from a few seconds to a minute or two.
A paid model on the same key removes that variance.

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
  env.js           loads server/.env regardless of the working directory
  db.js            MySQL pool, table prefixing, schema — PRD section 7, plus later
                   columns via ensureColumn
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
checks `information_schema.columns` first, since MySQL has no `ADD COLUMN IF NOT
EXISTS`. An existing database picks them up on next boot; no migration step to run.

### Storage

MySQL 8 via `mysql2`. `db.js` creates the schema on boot, so there is nothing to run by
hand. Two things about it are worth knowing:

**Every table is prefixed** — `MINDBRIDGE_TABLE_PREFIX`, default `mb_`. The database
this currently points at is shared with another application whose tables include
`doctors`, `patients`, `journal_entries` and `import_batches`: same names, entirely
different columns. The prefix is what keeps the two apart, and it is applied centrally
in `db.js` rather than being written into every query, so the SQL still reads as
`FROM patients`. **Do not blank it out against a shared database.**

**The statement API is async.** `db.prepare(sql).get/.all/.run` keeps the shape the old
`node:sqlite` code used, but all three now return promises — MySQL is a network round
trip and there is no synchronous equivalent to fake. Transactions are explicit
(`withTransaction`) because a pool hands out a different connection per statement, so a
bare `BEGIN` would land on an unrelated session. Bulk writes go through `insertMany`:
generating one patient writes ~150 rows, which against a remote server is the difference
between one round trip and a hundred.

Dates come back as strings (`dateStrings: true`) rather than JS `Date` objects, so the
API returns exactly what it did before, and timestamp defaults are `UTC_TIMESTAMP()`
rather than `CURRENT_TIMESTAMP` so they stay UTC regardless of the server's session time
zone — the client appends a `Z` when parsing them.

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
- The database credentials in `.env` are a shared hosting account whose MySQL is open to
  `%` (any host). That is the hosting panel's setting, not the app's, but it means the
  password is the only thing in front of the data — worth narrowing to a known IP.
- Report latency on free-tier models is unpredictable (seconds to a minute or two) and
  the UI has no progress indication beyond its loading state. 

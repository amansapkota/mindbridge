import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
export const SNIPPETS = JSON.parse(fs.readFileSync(path.join(dir, "snippets.json"), "utf8"));

/* ------------------------------------------------------------------ *
 * Randomness
 * Seeded so a given patient's dataset is reproducible (useful when
 * comparing prompt changes against the same data); "Regenerate data"
 * simply rolls a new seed.
 * ------------------------------------------------------------------ */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller, so values cluster around the mean instead of spreading flat. */
function gaussian(rand, mean, sd) {
  const u = Math.max(rand(), 1e-9);
  const v = Math.max(rand(), 1e-9);
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round1 = (v) => Math.round(v * 10) / 10;

/* ------------------------------------------------------------------ *
 * The severity mapping table (PRD 6.4: "documented mapping table ...
 * so it's tunable")
 *
 * Three anchors — health score 1 (high severity), 5.5 (moderate) and 10
 * (stable). A patient's actual score is linearly interpolated between the
 * two nearest anchors, so score 4 sits between "high" and "moderate"
 * rather than snapping to a bucket.
 * ------------------------------------------------------------------ */
export const SEVERITY_BANDS = {
  high: {
    label: "High severity",
    scoreRange: [1, 3],
    anchor: 1,
    metrics: {
      sleep_hours: { mean: 4.8, sd: 1.3 },
      sleep_quality: { mean: 38, sd: 14 },
      resting_hr: { mean: 82, sd: 7 },
      hrv: { mean: 28, sd: 8 },
      breathing_rate: { mean: 18.5, sd: 2.2 },
      mood_score: { mean: 2.6, sd: 1.3 },
      anxiety_score: { mean: 8.0, sd: 1.3 },
      energy_score: { mean: 2.8, sd: 1.2 },
    },
    logProbability: 0.55,
    journalProbability: 0.45,
  },
  moderate: {
    label: "Moderate",
    scoreRange: [4, 6],
    anchor: 5.5,
    metrics: {
      sleep_hours: { mean: 6.6, sd: 0.9 },
      sleep_quality: { mean: 62, sd: 11 },
      resting_hr: { mean: 70, sd: 5 },
      hrv: { mean: 45, sd: 9 },
      breathing_rate: { mean: 15.5, sd: 1.5 },
      mood_score: { mean: 5.5, sd: 1.2 },
      anxiety_score: { mean: 5.0, sd: 1.3 },
      energy_score: { mean: 5.4, sd: 1.2 },
    },
    logProbability: 0.8,
    journalProbability: 0.5,
  },
  stable: {
    label: "Stable",
    scoreRange: [7, 10],
    anchor: 10,
    metrics: {
      sleep_hours: { mean: 7.6, sd: 0.6 },
      sleep_quality: { mean: 82, sd: 7 },
      resting_hr: { mean: 60, sd: 4 },
      hrv: { mean: 65, sd: 10 },
      breathing_rate: { mean: 13.5, sd: 1.0 },
      mood_score: { mean: 8.2, sd: 0.9 },
      anxiety_score: { mean: 2.4, sd: 0.9 },
      energy_score: { mean: 7.9, sd: 0.9 },
    },
    logProbability: 0.95,
    journalProbability: 0.55,
  },
};

/** Which metrics get worse as the number goes up, rather than down. */
const HIGHER_IS_WORSE = new Set(["resting_hr", "breathing_rate", "anxiety_score"]);

const METRIC_BOUNDS = {
  sleep_hours: [0, 12],
  sleep_quality: [0, 100],
  resting_hr: [40, 120],
  hrv: [5, 120],
  breathing_rate: [8, 28],
  mood_score: [1, 10],
  anxiety_score: [1, 10],
  energy_score: [1, 10],
};

export function bucketForScore(score) {
  if (score <= 3) return "high";
  if (score <= 6) return "moderate";
  return "stable";
}

/** Interpolate the per-metric mean/sd for an arbitrary health score. */
function profileForScore(score) {
  const s = clamp(score, 1, 10);
  const [lo, hi] =
    s <= SEVERITY_BANDS.moderate.anchor
      ? [SEVERITY_BANDS.high, SEVERITY_BANDS.moderate]
      : [SEVERITY_BANDS.moderate, SEVERITY_BANDS.stable];

  const t = (s - lo.anchor) / (hi.anchor - lo.anchor);
  const metrics = {};
  for (const key of Object.keys(lo.metrics)) {
    metrics[key] = {
      mean: lo.metrics[key].mean + t * (hi.metrics[key].mean - lo.metrics[key].mean),
      sd: lo.metrics[key].sd + t * (hi.metrics[key].sd - lo.metrics[key].sd),
    };
  }
  return {
    metrics,
    logProbability: lo.logProbability + t * (hi.logProbability - lo.logProbability),
    journalProbability: lo.journalProbability + t * (hi.journalProbability - lo.journalProbability),
  };
}

const isoDate = (d) => d.toISOString().slice(0, 10);

/**
 * The core generator (PRD 6.4).
 *
 * Produces `days` of biometric + EMA data driven by `healthScore`, with
 * gaussian noise, a handful of deliberately worse "spike days", and days where
 * the patient simply didn't log — which is what gives 6.5's compliance score
 * something real to measure.
 */
export function generateTimeseries(healthScore, days = 30, seed = Date.now()) {
  const rand = mulberry32(seed);
  const profile = profileForScore(healthScore);

  // Sicker patients get more bad days. 1 -> ~5 spikes, 10 -> ~1.
  const spikeCount = Math.max(1, Math.round((11 - healthScore) / 2));
  const spikeDays = new Set();
  while (spikeDays.size < spikeCount) {
    // Keep spikes off the very first day so there's a baseline to deviate from.
    spikeDays.add(1 + Math.floor(rand() * (days - 1)));
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const points = [];
  for (let i = 0; i < days; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() - (days - 1 - i));

    const isSpike = spikeDays.has(i);
    // A spike pushes 1.5-2.5 sd in whichever direction is "worse".
    const spikeMagnitude = isSpike ? 1.5 + rand() : 0;

    const point = { date: isoDate(date), is_spike_day: isSpike };
    for (const [metric, { mean, sd }] of Object.entries(profile.metrics)) {
      const direction = HIGHER_IS_WORSE.has(metric) ? 1 : -1;
      const raw = gaussian(rand, mean + direction * spikeMagnitude * sd, sd);
      const [lo, hi] = METRIC_BOUNDS[metric];
      const value = clamp(raw, lo, hi);
      point[metric] =
        metric === "sleep_hours" || metric === "breathing_rate" ? round1(value) : Math.round(value);
    }
    points.push(point);
  }

  return { points, spikeDays: [...spikeDays].sort((a, b) => a - b), profile, seed };
}

/* ------------------------------------------------------------------ *
 * Mood logs and journals
 * ------------------------------------------------------------------ */

const TAGS_BY_MOOD = {
  low: ["low", "drained", "numb", "irritable", "anxious", "restless", "lonely", "hopeless"],
  mid: ["flat", "tired", "ok", "stressed", "distracted", "on edge", "quiet"],
  high: ["good", "calm", "rested", "motivated", "social", "content", "focused"],
};

function pickTags(rand, moodRating) {
  const pool = moodRating <= 3 ? TAGS_BY_MOOD.low : moodRating <= 6 ? TAGS_BY_MOOD.mid : TAGS_BY_MOOD.high;
  const count = 1 + Math.floor(rand() * 2); // 1-2 tags, per the PRD
  const chosen = new Set();
  while (chosen.size < count) chosen.add(pool[Math.floor(rand() * pool.length)]);
  return [...chosen];
}

/**
 * Weighted snippet pick: mostly from the patient's own band, but with a real
 * chance of a neighbouring band so the log isn't monotonous — a struggling
 * patient still has an ordinary day now and then.
 */
const BUCKET_ORDER = ["high", "moderate", "stable"];

/** One step worse than the given bucket, floored at "high". */
const worseBucket = (bucket) => BUCKET_ORDER[Math.max(0, BUCKET_ORDER.indexOf(bucket) - 1)];

function pickSnippet(rand, bucket, perspective, dayIsSpike) {
  // A bad day for a thriving patient is a moderate-tone entry, not a
  // substance-use one — spikes shift the target one band worse rather than
  // jumping to the most severe pool. Weight falls off with distance from that
  // target, so a band two steps away is rare enough to stay plausible.
  const target = dayIsSpike ? worseBucket(bucket) : bucket;
  const targetIndex = BUCKET_ORDER.indexOf(target);
  const falloff = [0.75, 0.22, 0.03];

  const weights = {};
  for (const [i, b] of BUCKET_ORDER.entries()) {
    weights[b] = falloff[Math.abs(i - targetIndex)];
  }

  const total = Object.values(weights).reduce((x, y) => x + y, 0);
  const roll = rand();
  let acc = 0;
  let chosenBucket = bucket;
  for (const [b, w] of Object.entries(weights)) {
    acc += w;
    if (roll <= acc / total) {
      chosenBucket = b;
      break;
    }
  }

  const candidates = SNIPPETS.filter((s) => s.perspective === perspective && s.severity_bucket === chosenBucket);
  const pool = candidates.length
    ? candidates
    : SNIPPETS.filter((s) => s.perspective === perspective && s.severity_bucket === bucket);
  return pool[Math.floor(rand() * pool.length)];
}

/**
 * Build one author's mood logs + journal entries across the generated window.
 * `points` supplies the same-day mood/spike context so journals and biometric
 * dips plausibly line up — which is the correlation the AI is asked to find.
 */
export function generateLogs(points, healthScore, perspective, seed, { moodOffset = 0 } = {}) {
  const rand = mulberry32(seed);
  const bucket = bucketForScore(healthScore);
  const profile = profileForScore(healthScore);

  const moodLogs = [];
  const journals = [];
  const missedDays = [];

  for (const point of points) {
    if (rand() > profile.logProbability) {
      missedDays.push(point.date);
      continue;
    }

    // The patient's own rating follows their EMA mood directly. The partner is
    // rating what they observe from outside, so their number is the same day
    // shifted by how differently they read the patient overall (moodOffset) plus
    // day-to-day noise — that shift is what produces the disagreements in 6.7.
    const base =
      perspective === "partner" ? point.mood_score + moodOffset + gaussian(rand, 0, 1.1) : point.mood_score;
    const moodRating = Math.round(clamp(base, 1, 10));

    moodLogs.push({ date: point.date, mood_rating: moodRating, tags: pickTags(rand, moodRating) });

    if (rand() <= profile.journalProbability || point.is_spike_day) {
      const snippet = pickSnippet(rand, bucket, perspective, point.is_spike_day);
      journals.push({ date: point.date, snippet_id: snippet.id, text: snippet.text });
    }
  }

  return { moodLogs, journals, missedDays };
}

/**
 * Compliance (PRD 6.5): expected one mood check-in per tracked day; score is
 * the share actually logged. Gaps are returned so the dashboard can show which
 * days were missed rather than just a number.
 */
export function computeCompliance(points, moodLogs) {
  const loggedDates = new Set(moodLogs.map((m) => m.date));
  const trackedDates = points.map((p) => p.date);

  // Only check-ins that land on a tracked day count towards coverage. Counting
  // every check-in instead would let the numerator exceed the denominator — a
  // patient who checks in on a day with no biometric data would read as "1 of 0
  // days logged", or push the score past 100%. That is now the common case:
  // patients start with no history and log through the portal, so a check-in
  // routinely arrives on a day the tracked window does not cover.
  const logged = trackedDates.filter((d) => loggedDates.has(d)).length;
  const expected = trackedDates.length;

  return {
    score: expected === 0 ? 0 : Math.round((logged / expected) * 100),
    expected,
    logged,
    missedDates: trackedDates.filter((d) => !loggedDates.has(d)),
  };
}

/**
 * Partner severity is rolled separately from the patient's (PRD 6.4): about
 * half the time it tracks the patient, the rest of the time it deliberately
 * diverges — that mismatch is the signal the doctor is meant to see.
 */
export function rollPartnerHealthScore(patientHealthScore, seed) {
  const rand = mulberry32(seed ^ 0x9e3779b9);
  const roll = rand();
  if (roll < 0.5) return clamp(Math.round(patientHealthScore + gaussian(rand, 0, 0.6)), 1, 10);
  // Diverge: the partner sees it as notably better or worse than the patient reports.
  const direction = rand() < 0.6 ? -1 : 1; // more often, the partner sees it as worse
  const gap = 2 + Math.floor(rand() * 3); // 2-4 points apart
  return clamp(patientHealthScore + direction * gap, 1, 10);
}

/** Full dataset for one patient, ready to persist. */
export function generateDataset({ healthScore, days = 30, hasPartner = false, seed = Date.now() }) {
  const { points, spikeDays } = generateTimeseries(healthScore, days, seed);

  const patientLogs = generateLogs(points, healthScore, "patient", seed + 1);
  const compliance = computeCompliance(points, patientLogs.moodLogs);

  let partner = null;
  if (hasPartner) {
    const partnerHealthScore = rollPartnerHealthScore(healthScore, seed);
    // A partner who reads the patient as 4 points worse rates the same days
    // lower, not just writes gloomier journals — keeps text and numbers telling
    // the same story.
    const moodOffset = (partnerHealthScore - healthScore) * 0.7;
    const partnerLogs = generateLogs(points, partnerHealthScore, "partner", seed + 2, { moodOffset });
    partner = { healthScore: partnerHealthScore, moodOffset: round1(moodOffset), ...partnerLogs };
  }

  return { points, spikeDays, compliance, patient: patientLogs, partner, seed, days };
}

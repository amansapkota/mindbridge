import { shortDate } from "./Charts.jsx";

export function StatTile({ label, value, unit, foot, tone }) {
  const color = tone === "critical" ? "var(--critical)" : tone === "good" ? "var(--good)" : "var(--text-primary)";
  return (
    <div className="card stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={{ color }}>
        {value}
        {unit && <span className="stat-unit">{unit}</span>}
      </div>
      {foot && <div className="stat-foot">{foot}</div>}
    </div>
  );
}

/** PRD 6.5 — the score plus the specific days behind it, not just a number. */
export function ComplianceCard({ compliance }) {
  if (!compliance) return null;
  const { score, logged, expected, missedDates = [] } = compliance;
  const tone = score >= 85 ? "var(--good)" : score >= 60 ? "var(--warning)" : "var(--critical)";

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">Check-in compliance</span>
        <span className="card-note">{logged} of {expected} days logged</span>
      </div>
      <div className="stat-value" style={{ color: tone }}>
        {score}
        <span className="stat-unit">%</span>
      </div>
      <div className="meter">
        <div className="meter-fill" style={{ width: `${score}%`, background: tone }} />
      </div>
      {missedDates.length > 0 ? (
        <p className="stat-foot">
          <strong>{missedDates.length} missed:</strong> {missedDates.slice(0, 10).map(shortDate).join(", ")}
          {missedDates.length > 10 ? ` +${missedDates.length - 10} more` : ""}
        </p>
      ) : (
        <p className="stat-foot">Complete coverage across the window.</p>
      )}
    </div>
  );
}

const moodDot = (rating) =>
  rating <= 3 ? "var(--critical)" : rating <= 6 ? "var(--warning)" : "var(--good)";

/**
 * Journal + mood entries interleaved by day. Days the report flagged are
 * highlighted so the text sits alongside the movement it explains.
 */
export function JournalTimeline({ journals = [], moodLogs = [], flaggedDates = [], emptyText }) {
  const byDate = new Map();
  for (const m of moodLogs) byDate.set(m.date, { date: m.date, mood: m });
  for (const j of journals) byDate.set(j.date, { ...(byDate.get(j.date) || { date: j.date }), journal: j });

  const rows = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
  if (rows.length === 0) return <div className="empty">{emptyText || "No entries in this window."}</div>;

  return (
    <div className="timeline">
      {rows.map((row) => (
        <div key={row.date} className={`entry ${flaggedDates.includes(row.date) ? "entry-flagged" : ""}`}>
          <div className="entry-date">{shortDate(row.date)}</div>
          <div>
            {row.mood && (
              <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: row.journal ? "0.3rem" : 0 }}>
                <span className="dot" style={{ background: moodDot(row.mood.mood_rating) }} />
                <strong style={{ fontSize: "0.85rem" }}>{row.mood.mood_rating}/10</strong>
                <span className="tag-row">
                  {row.mood.tags.map((t) => (
                    <span key={t} className="tag">{t}</span>
                  ))}
                </span>
              </div>
            )}
            {row.journal && <p className="entry-text">{row.journal.text}</p>}
          </div>
        </div>
      ))}
    </div>
  );
}

/** PRD 6.7 — patient's account beside the observer's, mismatches called out. */
export function PartnerCompare({ patientMoods = [], partnerMoods = [], patientJournals = [], partnerJournals = [], partnerName }) {
  const dates = [...new Set([...patientMoods, ...partnerMoods].map((m) => m.date))].sort((a, b) => b.localeCompare(a));

  const pMood = new Map(patientMoods.map((m) => [m.date, m]));
  const oMood = new Map(partnerMoods.map((m) => [m.date, m]));
  const pJournal = new Map(patientJournals.map((j) => [j.date, j]));
  const oJournal = new Map(partnerJournals.map((j) => [j.date, j]));

  const rows = dates.filter((d) => pMood.has(d) || oMood.has(d));
  if (rows.length === 0) return <div className="empty">No overlapping entries.</div>;

  const gap = (d) => {
    const a = pMood.get(d)?.mood_rating;
    const b = oMood.get(d)?.mood_rating;
    return a != null && b != null ? Math.abs(a - b) : 0;
  };

  return (
    <div>
      <div className="compare">
        <div className="compare-head">
          <span className="dot" style={{ background: "var(--series-1)" }} /> Patient
        </div>
        <div className="compare-head">
          <span className="dot" style={{ background: "var(--series-4)" }} /> {partnerName || "Partner"}
        </div>
      </div>
      <div className="timeline">
        {rows.map((date) => {
          const mismatch = gap(date) >= 3;
          return (
            <div key={date} className={mismatch ? "mismatch-row" : ""} style={{ borderRadius: 6, padding: "0.15rem 0.4rem" }}>
              <div className="entry-date" style={{ paddingTop: "0.4rem" }}>
                {shortDate(date)}
                {mismatch && (
                  <span className="badge badge-moderate" style={{ marginLeft: "0.4rem" }}>
                    differs by {gap(date)}
                  </span>
                )}
              </div>
              <div className="compare">
                <Side mood={pMood.get(date)} journal={pJournal.get(date)} />
                <Side mood={oMood.get(date)} journal={oJournal.get(date)} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Side({ mood, journal }) {
  if (!mood && !journal) return <div className="entry-text muted" style={{ padding: "0.4rem 0" }}>— no entry</div>;
  return (
    <div style={{ padding: "0.35rem 0 0.7rem" }}>
      {mood && (
        <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: journal ? "0.3rem" : 0 }}>
          <span className="dot" style={{ background: moodDot(mood.mood_rating) }} />
          <strong style={{ fontSize: "0.85rem" }}>{mood.mood_rating}/10</strong>
          <span className="tag-row">
            {mood.tags.map((t) => (
              <span key={t} className="tag">{t}</span>
            ))}
          </span>
        </div>
      )}
      {journal && <p className="entry-text">{journal.text}</p>}
    </div>
  );
}

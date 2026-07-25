import { useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/**
 * Recharts writes colours as SVG presentation attributes, where `var(--x)`
 * doesn't resolve — so read the tokens off the document and re-read when the
 * OS theme flips.
 */
export function useThemeColors() {
  const read = () => {
    const s = getComputedStyle(document.documentElement);
    const get = (name) => s.getPropertyValue(name).trim();
    return {
      series1: get("--series-1"),
      series2: get("--series-2"),
      series3: get("--series-3"),
      series4: get("--series-4"),
      critical: get("--critical"),
      grid: get("--gridline"),
      axis: get("--baseline"),
      muted: get("--text-muted"),
      text: get("--text-primary"),
      surface: get("--surface-1"),
    };
  };

  const [colors, setColors] = useState(read);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setColors(read());
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return colors;
}

export const shortDate = (d) =>
  new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

function ChartTooltip({ active, payload, label, colors, unit = "" }) {
  if (!active || !payload?.length) return null;
  return (
    <div
      style={{
        background: colors.surface,
        border: `1px solid ${colors.grid}`,
        borderRadius: 8,
        padding: "0.5rem 0.65rem",
        fontSize: "0.8rem",
        boxShadow: "0 4px 14px rgba(0,0,0,0.12)",
      }}
    >
      <div style={{ color: colors.muted, marginBottom: 4 }}>{shortDate(label)}</div>
      {payload.map((p) => (
        <div key={p.dataKey} style={{ display: "flex", alignItems: "center", gap: 6, color: colors.text }}>
          <span style={{ width: 8, height: 8, borderRadius: 4, background: p.color, display: "inline-block" }} />
          <span>{p.name}</span>
          <strong style={{ marginLeft: "auto", fontVariantNumeric: "tabular-nums" }}>
            {p.value}
            {unit}
          </strong>
        </div>
      ))}
    </div>
  );
}

const axisProps = (colors) => ({
  stroke: colors.axis,
  tick: { fill: colors.muted, fontSize: 11 },
  tickLine: false,
});

/** Mood / anxiety / energy — all 1-10, so they legitimately share one axis. */
export function MoodChart({ points, spikeDates = [], height = 240 }) {
  const colors = useThemeColors();
  const spikes = points.filter((p) => spikeDates.includes(p.date));

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
        <CartesianGrid stroke={colors.grid} vertical={false} />
        <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={28} {...axisProps(colors)} />
        <YAxis domain={[0, 10]} ticks={[0, 2, 4, 6, 8, 10]} {...axisProps(colors)} />
        <Tooltip content={<ChartTooltip colors={colors} unit="/10" />} />
        <Legend wrapperStyle={{ fontSize: "0.8rem", color: colors.muted }} iconType="plainline" />
        <Line type="monotone" dataKey="mood_score" name="Mood" stroke={colors.series1} strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="anxiety_score" name="Anxiety" stroke={colors.series2} strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="energy_score" name="Energy" stroke={colors.series3} strokeWidth={2} dot={false} />
        {spikes.map((s) => (
          <ReferenceDot
            key={s.date}
            x={s.date}
            y={s.mood_score}
            r={5}
            fill={colors.critical}
            stroke={colors.surface}
            strokeWidth={2}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Sleep duration. Quality lives in its own chart — never a second y-axis. */
export function SleepChart({ points, spikeDates = [], height = 200 }) {
  const colors = useThemeColors();
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: -18 }} barCategoryGap="18%">
        <CartesianGrid stroke={colors.grid} vertical={false} />
        <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={28} {...axisProps(colors)} />
        <YAxis domain={[0, 10]} ticks={[0, 2, 4, 6, 8, 10]} {...axisProps(colors)} />
        <Tooltip content={<ChartTooltip colors={colors} unit="h" />} cursor={{ fill: colors.grid, opacity: 0.4 }} />
        <Bar
          dataKey="sleep_hours"
          name="Sleep"
          radius={[4, 4, 0, 0]}
          maxBarSize={16}
          fill={colors.series1}
          // Flagged days keep the reserved status colour so they read as state,
          // not as another series.
          shape={(props) => {
            const flagged = spikeDates.includes(props.payload.date);
            const { x, y, width, height: h } = props;
            return <rect x={x} y={y} width={width} height={h} rx={4} fill={flagged ? colors.critical : colors.series1} />;
          }}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** One metric, one axis, one colour — used as small multiples. */
export function MetricChart({ points, dataKey, name, unit = "", color, domain, height = 150 }) {
  const colors = useThemeColors();
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: -20 }}>
        <CartesianGrid stroke={colors.grid} vertical={false} />
        <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={40} {...axisProps(colors)} />
        <YAxis domain={domain || ["auto", "auto"]} {...axisProps(colors)} />
        <Tooltip content={<ChartTooltip colors={colors} unit={unit} />} />
        <Line
          type="monotone"
          dataKey={dataKey}
          name={name}
          stroke={color || colors.series1}
          strokeWidth={2}
          dot={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Patient self-rating vs partner observation — two series, one 1-10 axis. */
export function MoodComparisonChart({ patientLogs, partnerLogs, partnerName, height = 220 }) {
  const colors = useThemeColors();

  const byDate = new Map();
  for (const m of patientLogs) byDate.set(m.date, { date: m.date, patient: m.mood_rating });
  for (const m of partnerLogs) {
    byDate.set(m.date, { ...(byDate.get(m.date) || { date: m.date }), partner: m.mood_rating });
  }
  const data = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

  const mismatches = data.filter((d) => d.patient != null && d.partner != null && Math.abs(d.patient - d.partner) >= 3);

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
        <CartesianGrid stroke={colors.grid} vertical={false} />
        <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={28} {...axisProps(colors)} />
        <YAxis domain={[0, 10]} ticks={[0, 2, 4, 6, 8, 10]} {...axisProps(colors)} />
        <Tooltip content={<ChartTooltip colors={colors} unit="/10" />} />
        <Legend wrapperStyle={{ fontSize: "0.8rem", color: colors.muted }} iconType="plainline" />
        <Line
          type="monotone"
          dataKey="patient"
          name="Patient's own rating"
          stroke={colors.series1}
          strokeWidth={2}
          connectNulls
          dot={false}
        />
        <Line
          type="monotone"
          dataKey="partner"
          name={`${partnerName || "Partner"}'s observation`}
          stroke={colors.series4}
          strokeWidth={2}
          strokeDasharray="5 3"
          connectNulls
          dot={false}
        />
        {mismatches.map((m) => (
          <ReferenceDot
            key={m.date}
            x={m.date}
            y={Math.max(m.patient, m.partner)}
            r={5}
            fill={colors.critical}
            stroke={colors.surface}
            strokeWidth={2}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

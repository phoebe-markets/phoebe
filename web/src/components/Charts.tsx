import { useMemo } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { HistoryPoint } from "../store";
import { cents, lev, when } from "../format";

const MAX_POINTS = 600;

/** Keep the chart responsive on 7k+ ticks: bucket to <= MAX_POINTS, keeping each bucket's last point. */
function downsample(h: HistoryPoint[]) {
  if (h.length <= MAX_POINTS) return h;
  const step = Math.ceil(h.length / MAX_POINTS);
  const out: HistoryPoint[] = [];
  for (let i = step - 1; i < h.length; i += step) out.push(h[i]);
  if (out[out.length - 1] !== h[h.length - 1]) out.push(h[h.length - 1]);
  return out;
}

const axisProps = {
  stroke: "var(--axis)",
  tick: { fill: "var(--muted)", fontSize: 11 },
  tickLine: false,
} as const;

/** Dates when the window spans days; date + hour when it's short enough that dates would repeat. */
function makeTick(span: number) {
  return (t: number) =>
    new Date(t * 1000).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      ...(span < 4 * 86_400 ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
      timeZone: "UTC",
    });
}

function TipBox({ active, payload, rows }: { active?: boolean; payload?: { payload: HistoryPoint }[]; rows: (p: HistoryPoint) => [string, string, string?][] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="tooltip">
      <div className="muted">{when(p.t)} UTC</div>
      {rows(p).map(([k, v, color]) => (
        <div className="row" key={k}>
          <span>
            {color && <i className="key" style={{ background: color, width: 8, height: 8 }} />}
            {k}
          </span>
          <b>{v}</b>
        </div>
      ))}
    </div>
  );
}

/**
 * Two stacked small multiples on one time axis (never a dual axis): the YES price, and the max leverage the
 * risk engine allowed for YES and NO at each oracle update. A shared crosshair links them (syncId).
 */
export function MarketCharts({ history }: { history: HistoryPoint[] }) {
  const data = useMemo(() => downsample(history), [history]);
  if (data.length < 2) return <div className="empty">Waiting for oracle history…</div>;
  const maxLev = Math.max(2, ...data.map((d) => Math.max(d.yesLev, d.noLev)));
  const dateTick = makeTick(data[data.length - 1].t - data[0].t);

  return (
    <div>
      <div className="chart-title">YES price</div>
      <ResponsiveContainer width="100%" height={180}>
        <LineChart data={data} syncId="mkt" margin={{ top: 8, right: 44, bottom: 6, left: 8 }}>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={dateTick} {...axisProps} hide />
          <YAxis domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tickFormatter={(v) => `${Math.round(v * 100)}¢`} width={40} {...axisProps} />
          <Tooltip
            cursor={{ stroke: "var(--muted)", strokeWidth: 1 }}
            content={<TipBox rows={(p) => [["YES", cents(p.yes), "var(--series-yes)"], ["NO", cents(1 - p.yes)]]} />}
          />
          <Line type="linear" dataKey="yes" stroke="var(--series-yes)" strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>

      <div className="chart-title">
        Max leverage allowed
        <span className="legend-item">
          <i style={{ background: "var(--series-yes)" }} />
          Long YES
        </span>
        <span className="legend-item">
          <i style={{ background: "var(--series-no)" }} />
          Long NO
        </span>
      </div>
      <ResponsiveContainer width="100%" height={150}>
        <LineChart data={data} syncId="mkt" margin={{ top: 8, right: 44, bottom: 6, left: 8 }}>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={dateTick} minTickGap={40} {...axisProps} />
          <YAxis domain={[1, Math.ceil(maxLev)]} tickFormatter={(v) => `${v}x`} width={40} allowDecimals={false} {...axisProps} />
          <Tooltip
            cursor={{ stroke: "var(--muted)", strokeWidth: 1 }}
            content={
              <TipBox
                rows={(p) => [
                  ["Long YES", lev(p.yesLev), "var(--series-yes)"],
                  ["Long NO", lev(p.noLev), "var(--series-no)"],
                ]}
              />
            }
          />
          <Line type="stepAfter" dataKey="yesLev" stroke="var(--series-yes)" strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line type="stepAfter" dataKey="noLev" stroke="var(--series-no)" strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

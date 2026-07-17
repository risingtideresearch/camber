import { useSyncExternalStore } from "react";
import { perfSnapshot, perfSubscribe, type PerfSettings } from "../core/perf";
import "./PerfPanel.css";

// The Performance readout: what the last redraw of each view cost, step by step. It is a card in its own
// resizable column (EditorApp mounts it while the toggle is on) rather than an overlay, because the numbers
// are read while dragging something in another view — a panel that covered one would be in its own way.
//
// The registry (core/perf) is an external store, not React state: the draws are imperative and run inside
// effects, so the panel subscribes to their measurements instead of being handed them. `perfSnapshot` is
// rebuilt once per frame, which is what makes it safe to read here — the identity only changes when the
// numbers do, so the panel re-renders once per frame at most and never drives a redraw of its own.
interface PerfPanelProps {
  settings: PerfSettings;
}

const fmtMs = (v: number): string =>
  Number.isNaN(v) ? "—" : v < 10 ? v.toFixed(2) : v.toFixed(1);

export function PerfPanel({ settings }: PerfPanelProps) {
  const groups = useSyncExternalStore(perfSubscribe, perfSnapshot);
  // the smoothed number is the honest one to read live; the raw one is there for a single deliberate edit
  const val = (m: { ms: number; avg: number }): number =>
    settings.smooth ? m.avg : m.ms;
  const total = groups.reduce(
    (s, g) => s + (Number.isNaN(val(g)) ? 0 : val(g)),
    0,
  );

  return (
    <div className="card perfcard">
      <div className="cap">
        Performance
        <span
          className="val"
          title="The sum of the last pass of every view — roughly what one edit costs, since a model change redraws all of them"
        >
          {fmtMs(total)} ms
        </span>
      </div>
      <div className="perfbody">
        {groups.length === 0 && (
          <div className="perfempty">
            Nothing measured yet — drag a point to redraw.
          </div>
        )}
        {groups.map((g) => {
          const rows = settings.sort
            ? [...g.metrics].sort((a, b) => val(b) - val(a))
            : g.metrics;
          return (
            <div className="perfgroup" key={g.title}>
              <div className="perfghead">
                <span>{g.title}</span>
                <span className="perfms">{fmtMs(val(g))}</span>
              </div>
              {rows.map((m) => (
                <div className="perfrow" key={m.label}>
                  <span className="perflabel">
                    {m.label}
                    {m.calls > 1 && (
                      <span
                        className="perfcalls"
                        title={`ran ${m.calls} times in this pass`}
                      >
                        {" ×" + m.calls}
                      </span>
                    )}
                  </span>
                  <span className="perfn">
                    {m.n !== null ? `${m.n.toLocaleString()} ${m.unit}` : ""}
                  </span>
                  <span className="perfms">{fmtMs(val(m))}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

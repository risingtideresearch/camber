import { useEditorUi } from "./editorUi";
import { useSyncExternalStore } from "react";
import { perfSnapshot, perfSubscribe } from "../core/perf";
import "./PerfPanel.css";

// The Performance readout: what the last redraw of each view cost, step by step. It is a card in its own
// resizable column (EditorApp mounts it while the toggle is on) rather than an overlay, because the numbers
// are read while dragging something in another view — a panel that covered one would be in its own way.
//
// The registry (core/perf) is an external store, not React state: the draws are imperative and run inside
// effects, so the panel subscribes to their measurements instead of being handed them. `perfSnapshot` is
// rebuilt once per frame, which is what makes it safe to read here — the identity only changes when the
// numbers do, so the panel re-renders once per frame at most and never drives a redraw of its own.
//
// The headline is the FRAME — one edit, measured end to end — rather than the sum of the passes, which is
// only the part of it this app times. The difference between the two is the "React, three.js & the
// collector" row of the frame's own block: under the dev server it is most of the frame, since StrictMode
// runs every useMemo twice (the passes that ran twice say so with a ×2) on top of React's development build.

const fmtMs = (v: number): string =>
  Number.isNaN(v) ? "—" : v < 10 ? v.toFixed(2) : v.toFixed(1);

export function PerfPanel() {
  const { perf: settings } = useEditorUi();
  const { frame, groups } = useSyncExternalStore(perfSubscribe, perfSnapshot);
  // the smoothed number is the honest one to read live; the raw one is there for a single deliberate edit
  const val = (m: { ms: number; avg: number }): number =>
    settings.smooth ? m.avg : m.ms;
  const total = frame ? val(frame) : NaN;

  return (
    <div className="card perfcard">
      <div className="cap">
        Performance
        <span
          className="val"
          title="What one edit costs, measured from the edit to the next one — every pass below plus everything nobody times"
        >
          {fmtMs(total)} ms
          {/* the rate the frame time on the left comes to, rather than a second measurement of its own:
              two numbers of the same thing that could drift apart invite reading the disagreement as a
              finding, when it would only ever have been the two averages covering different frames */}
          {total > 0 && (
            <span
              className="perffps"
              title="What that comes to as a frame rate — while dragging, the rate on screen"
            >
              {" "}
              {(1000 / total).toFixed(1)} fps
            </span>
          )}
        </span>
      </div>
      <div className="perfbody">
        {groups.length === 0 && (
          <div className="perfempty">
            Nothing measured yet — drag a point to redraw.
          </div>
        )}
        {(frame ? [frame, ...groups] : groups).map((g) => {
          const rows = settings.sort
            ? [...g.metrics].sort((a, b) => val(b) - val(a))
            : g.metrics;
          return (
            <div
              className={"perfgroup" + (g === frame ? " perfframe" : "")}
              key={g.title}
            >
              <div className="perfghead">
                <span>
                  {g.title}
                  {/* the same part of a pass opened more than once in one frame — the same view redrawn twice
                      for one edit, which is what StrictMode's double-invoked useMemo does to the two
                      expensive ones. A pass spread over several brackets does not count: the 3D view's three
                      are one rebuild, not three of it (core/perf) */}
                  {g.repeats > 1 && (
                    <span
                      className="perfcalls"
                      title={`this pass's work ran ${g.repeats} times over in one frame; the time is all of them`}
                    >
                      {" ×" + g.repeats}
                    </span>
                  )}
                </span>
                <span className="perfms">{fmtMs(val(g))}</span>
              </div>
              {rows.map((m) => (
                <div className="perfrow" key={m.label}>
                  <span className="perflabel">
                    {m.label}
                    {m.calls > 1 && (
                      <span
                        className="perfcalls"
                        title={`ran ${m.calls} times in this frame`}
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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createModel, prepare, resetModel, type Model } from "../core/model";
import { loadJsonText, unitScale } from "../core/json";
import { listDesigns, type DesignRow } from "../core/supabase";
import {
  fleetResistance,
  spectrum,
  thetaCutoff,
  thetaGrid,
  waveField,
  G,
  inUsefulRange,
  KNOT,
  NODES_PER_CYCLE,
  USEFUL_FROUDE,
  RHO_FRESH,
  RHO_SALT,
  type FieldGrid,
  type FieldResult,
  type FleetResult,
  type Placement,
  type ThetaGrid,
} from "../core/michell";
import { paintWake, rampCss, robustScale } from "../core/wakeImage";
import {
  defaultView,
  gridOf,
  prepareHullFor,
  usefulSpeeds,
  type HullWake,
} from "../core/wake";
import { TopBar } from "../components/TopBar";
import { Button } from "../components/Button";
import { SpectrumPlot } from "./SpectrumPlot";
import "./MichellApp.css";

// ---------- the fleet wake study ----------
//
// Two hulls in one wave field, and what happens to the wave-making resistance as they are moved relative to
// each other. Thin-ship amplitudes SUPERPOSE, and that one fact shapes the whole page:
//
//   • the combined resistance is |Σ_j F_j·e^{iφ_j}|², where φ_j is nothing but the hull's placement phase — so
//     R_w and the interference factor update EXACTLY while a hull is dragged, at the cost of one pass over the
//     θ grid. A few thousand operations, not a re-solve.
//   • each hull's ELEVATION field is likewise its own field translated. So it is computed once per speed on a
//     PADDED grid, and dragging recomposites the picture by shifting and adding rasters. Nothing about the
//     physics reruns, which is what keeps dragging smooth even though building one field costs a fair
//     fraction of a second.
//
// That is the point of the page: interference is a placement question, and a placement question is only
// answerable if you can move things and watch the answer move.
//
// Everything expensive runs in an effect behind a frame, never in render — the heavy step is hundreds of
// milliseconds and must not block the paint that shows the control you just moved.

const RES = 400; // field width in pixels
const PAD = 0.3; // fraction of the view the padded field extends past each edge — i.e. the drag range
const SPREAD = 3; // the pair's default half-separation [m]

interface SlotMeta {
  id: string | null; // supabase design id, or null for camber's default hull
  name: string;
  at: Placement;
  err: string | null;
}

interface Solved {
  key: string;
  U: number;
  nu: number;
  g: FieldGrid; // the view
  pg: FieldGrid; // the padded grid each hull's own field lives on
  px: number;
  py: number;
  grid: ThetaGrid;
  fields: FieldResult[];
  hulls: HullWake[];
  ms: number;
}

const rhoOf = (salt: boolean): number => (salt ? RHO_SALT : RHO_FRESH);

export function MichellApp() {
  const [models] = useState<Model[]>(() => [createModel(), createModel()]);
  const [metas, setMetas] = useState<SlotMeta[]>(() => [
    { id: null, name: "default hull", at: { dx: 0, dy: -SPREAD }, err: null },
    { id: null, name: "default hull", at: { dx: 0, dy: SPREAD }, err: null },
  ]);
  const [rows, setRows] = useState<DesignRow[]>([]);
  const [knots, setKnots] = useState(6);
  const [salt, setSalt] = useState(true);
  const [pair, setPair] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [version, setVersion] = useState(0); // bumped when a slot's MODEL changes
  const [sampled, setSampled] = useState<{
    key: string;
    hulls: (HullWake | null)[];
    errs: (string | null)[];
    ms: number;
  } | null>(null);
  const [solved, setSolved] = useState<Solved | null>(null);
  const fieldPane = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);

  // The design list, and the ?id= the library hands over: it names hull A, and hull B is left as the default
  // so the page opens on a comparison rather than on a single hull doubled.
  useEffect(() => {
    let cancelled = false;
    void listDesigns()
      .then((list) => {
        if (cancelled) return;
        setRows(list);
        const id = new URLSearchParams(window.location.search).get("id");
        const row = id ? list.find((r) => r.id === id) : null;
        if (!row) return;
        try {
          loadJsonText(models[0], JSON.stringify(row.document));
          setMetas((prev) =>
            prev.map((m, k) =>
              k === 0
                ? { ...m, id: row.id, name: row.name || "untitled", err: null }
                : m,
            ),
          );
          setVersion((v) => v + 1);
        } catch (e) {
          const err = e instanceof Error ? e.message : String(e);
          setMetas((prev) => prev.map((m, k) => (k === 0 ? { ...m, err } : m)));
        }
      })
      .catch(() => setRows([]));
    return () => {
      cancelled = true;
    };
  }, [models]);

  // ---- sample each hull into a centreplane node cloud ----
  //
  // Not "once per model edit": once per (model, resolution class). The kernel exp(i·ν·secθ·X) has wavelength
  // 2π/(ν·secθ) with ν = g/U², so the grid a sample needs depends on the SPEED, and a cloud built for six
  // knots aliases badly at one — silently (michell.ts §1b). prepareHullFor sizes it; the ladder those sizes
  // are quantized onto is what keeps the speed slider from re-sampling on every tick.
  const sampleKey = `${version}|${Math.round(knots * 10)}`;
  useEffect(() => {
    let cancelled = false;
    const id = requestAnimationFrame(() => {
      if (cancelled) return;
      const t0 = performance.now();
      const hulls: (HullWake | null)[] = [],
        errs: (string | null)[] = [];
      const U = Math.max(0.05, knots * KNOT);
      for (const m of models) {
        try {
          prepare(m);
          const h = prepareHullFor(m, unitScale(m.unit, "m"), U);
          hulls.push(h);
          errs.push(h ? null : "no wetted hull at this waterline");
        } catch (e) {
          hulls.push(null);
          errs.push(e instanceof Error ? e.message : String(e));
        }
      }
      setSampled({ key: sampleKey, hulls, errs, ms: performance.now() - t0 });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(id);
    };
  }, [models, sampleKey, knots]);

  const live = useMemo(
    () =>
      (sampled?.hulls ?? [])
        .slice(0, pair ? 2 : 1)
        .filter((h): h is HullWake => !!h),
    [sampled, pair],
  );

  // ---- the θ grid and each hull's own padded field. Once per speed / hull; independent of placement, which
  // is exactly why placement is free afterwards.
  const solveKey = `${sampled?.key ?? "-"}|${pair}|${live.length}`;
  useEffect(() => {
    if (!live.length) return;
    let cancelled = false;
    const id = requestAnimationFrame(() => {
      if (cancelled) return;
      const t0 = performance.now();
      const U = Math.max(0.05, knots * KNOT),
        nu = G / (U * U);
      // The view is sized from the hulls at the ORIGIN, never from where they currently sit: a view that
      // tracked the placement would rescale under the pointer mid-drag. The transverse extent is widened to
      // leave room for a pair to be separated inside the picture.
      const base = defaultView(
        live.map((h) => ({ h, at: { dx: 0, dy: 0 } })),
        3,
        RES,
      );
      const yMax = base.yMax * 1.35;
      const view = {
        ...base,
        yMax,
        ny: Math.max(
          2,
          Math.round((base.nx * 2 * yMax) / (base.xMax - base.xMin)),
        ),
      };
      const g = gridOf(view);
      const px = Math.round(PAD * view.nx),
        py = Math.round(PAD * view.ny);
      const pg: FieldGrid = {
        x0: g.x0 - px * g.dx,
        dx: g.dx,
        nx: g.nx + 2 * px,
        y0: g.y0 - py * g.dy,
        dy: g.dy,
        ny: g.ny + 2 * py,
      };
      // the angular grid is sized to the PICTURE's reach: a field point far astern accumulates phase
      // ν·secθ·R, so a longer view needs finer angular sampling or the diverging waves alias
      const reach = Math.max(pg.nx * pg.dx, pg.ny * pg.dy);
      const grid = thetaGrid(nu, reach, thetaCutoff(11.5), 1.0);
      const fields = live.map((h) => {
        const sp = spectrum(h.cp, nu, grid.theta);
        return waveField(
          [{ re: sp.re, im: sp.im, at: { dx: 0, dy: 0 } }],
          grid,
          nu,
          pg,
        );
      });
      setSolved({
        key: solveKey,
        U,
        nu,
        g,
        pg,
        px,
        py,
        grid,
        fields,
        hulls: live,
        ms: performance.now() - t0,
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(id);
    };
  }, [live, knots, solveKey]);

  const fresh = solved?.key === solveKey;

  // ---- resistance. Pure, and cheap enough to redo on every pointer move, so the numbers stay exact at every
  // placement rather than snapping to the raster the picture is composited on.
  const res = useMemo((): FleetResult | null => {
    if (!solved || !fresh) return null;
    return fleetResistance(
      solved.hulls.map((h, k) => ({ cp: h.cp, at: metas[k].at })),
      { U: solved.U, rho: rhoOf(salt) },
      solved.grid,
    );
  }, [solved, fresh, metas, salt]);

  // ---- composite the placed fields and paint ----
  const repaint = useCallback(() => {
    const c = canvas.current;
    if (!c || !solved || !fresh) return;
    const { g, pg, px, py, fields, hulls } = solved;
    c.width = g.nx;
    c.height = g.ny;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    // shift-and-add: each hull's precomputed field, offset by its placement in whole pixels. Exact but for the
    // sub-pixel remainder, and about four orders of magnitude cheaper than re-evaluating the integral.
    const z = new Float64Array(g.nx * g.ny);
    for (let k = 0; k < hulls.length; k++) {
      const at = metas[k].at,
        sx = px - Math.round(at.dx / g.dx),
        sy = py - Math.round(at.dy / g.dy),
        f = fields[k].z;
      for (let j = 0; j < g.ny; j++) {
        const jj = j + sy;
        if (jj < 0 || jj >= pg.ny) continue;
        const src = jj * pg.nx + sx,
          dst = j * g.nx;
        for (let i = 0; i < g.nx; i++) {
          const ii = i + sx;
          if (ii < 0 || ii >= pg.nx) continue;
          z[dst + i] += f[src + i];
        }
      }
    }
    const validAft = Math.min(
      ...hulls.map((h, k) => h.sternX + metas[k].at.dx),
    );
    ctx.putImageData(
      paintWake(
        { z, max: 0, bandLimited: fields.some((f) => f.bandLimited) },
        g,
        solved.nu,
        { scale: robustScale(z), validAft },
      ),
      0,
      0,
    );
    const toX = (x: number): number => (x - g.x0) / g.dx,
      toY = (y: number): number => (y - g.y0) / g.dy;
    hulls.forEach((h, k) => {
      const at = metas[k].at;
      ctx.strokeStyle =
        k === 0 ? "rgba(255,255,255,0.92)" : "rgba(120,255,220,0.92)";
      ctx.lineWidth = 1.3;
      for (const side of [1, -1]) {
        ctx.beginPath();
        h.outline.forEach(([x, y], i) => {
          const X = toX(x + at.dx),
            Y = toY(side * y + at.dy);
          if (i) ctx.lineTo(X, Y);
          else ctx.moveTo(X, Y);
        });
        ctx.stroke();
      }
    });
  }, [solved, fresh, metas]);

  useEffect(repaint, [repaint]);

  const changeZoom = (value: number): void => {
    const next = Math.max(1, Math.min(4, value));
    const pane = fieldPane.current;
    const old = zoom;
    setZoom(next);
    if (!pane || next === old) return;
    const centerX = pane.scrollLeft + pane.clientWidth / 2;
    const centerY = pane.scrollTop + pane.clientHeight / 2;
    requestAnimationFrame(() => {
      pane.scrollLeft = centerX * (next / old) - pane.clientWidth / 2;
      pane.scrollTop = centerY * (next / old) - pane.clientHeight / 2;
    });
  };

  // ---- dragging a hull ----
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const c = canvas.current;
    if (!c || !solved || !fresh) return;
    const r = c.getBoundingClientRect(),
      { g, hulls } = solved;
    const toWorld = (cx: number, cy: number): [number, number] => [
      g.x0 + ((cx - r.left) / r.width) * g.nx * g.dx,
      g.y0 + ((cy - r.top) / r.height) * g.ny * g.dy,
    ];
    const [wx, wy] = toWorld(e.clientX, e.clientY);
    let best = -1,
      bd = Infinity;
    hulls.forEach((h, k) => {
      const at = metas[k].at,
        d = Math.hypot(wx - ((h.sternX + h.bowX) / 2 + at.dx), wy - at.dy);
      if (d < bd) {
        bd = d;
        best = k;
      }
    });
    if (best < 0 || bd > 1.2 * (hulls[best].bowX - hulls[best].sternX)) return; // open water, not a hull
    const at0 = { ...metas[best].at },
      idx = best;
    // clamp to the padded field: outside it there is no precomputed wake left to shift into view
    const limX = PAD * g.nx * g.dx,
      limY = PAD * g.ny * g.dy;
    const move = (ev: PointerEvent): void => {
      const [mx, my] = toWorld(ev.clientX, ev.clientY);
      const dx = Math.max(-limX, Math.min(limX, at0.dx + (mx - wx))),
        dy = Math.max(-limY, Math.min(limY, at0.dy + (my - wy)));
      setMetas((prev) =>
        prev.map((m, k) => (k === idx ? { ...m, at: { dx, dy } } : m)),
      );
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ---- loading a design into a slot ----
  const loadInto = (k: number, id: string | null): void => {
    const m = models[k];
    let name = "default hull",
      err: string | null = null;
    try {
      if (!id) resetModel(m);
      else {
        const row = rows.find((r) => r.id === id);
        if (!row) throw new Error("design not found");
        loadJsonText(m, JSON.stringify(row.document));
        name = row.name || "untitled";
      }
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    setMetas((prev) =>
      prev.map((s, j) => (j === k ? { ...s, id, name, err } : s)),
    );
    setVersion((v) => v + 1);
  };

  const bringIntoView = (): void => {
    setMetas((prev) => {
      if (!solved || !fresh) return prev;
      const count = pair ? 2 : 1;
      const { g, hulls } = solved;
      const x1 = g.x0 + (g.nx - 1) * g.dx;
      const y1 = g.y0 + (g.ny - 1) * g.dy;
      const marginX = 0.025 * (x1 - g.x0);
      const marginY = 0.025 * (y1 - g.y0);
      const fieldLimitX = PAD * g.nx * Math.abs(g.dx);
      const fieldLimitY = PAD * g.ny * Math.abs(g.dy);
      const inside = (value: number, low: number, high: number): number =>
        low <= high ? Math.max(low, Math.min(high, value)) : (low + high) / 2;

      return prev.map((m, k) => {
        if (k >= count || !hulls[k]) return m;
        const h = hulls[k];
        const halfBeam = h.cp.beamMax / 2;
        const dx = inside(
          m.at.dx,
          Math.max(g.x0 + marginX - h.sternX, -fieldLimitX),
          Math.min(x1 - marginX - h.bowX, fieldLimitX),
        );
        const dy = inside(
          m.at.dy,
          Math.max(g.y0 + marginY + halfBeam, -fieldLimitY),
          Math.min(y1 - marginY - halfBeam, fieldLimitY),
        );
        return { ...m, at: { dx, dy } };
      });
    });
    setZoom(1);
    requestAnimationFrame(() => fieldPane.current?.scrollTo(0, 0));
  };

  const resetPlacement = (): void =>
    setMetas((prev) =>
      prev.map((m, k) => ({
        ...m,
        at: { dx: 0, dy: k === 0 ? -SPREAD : SPREAD },
      })),
    );

  const fmtN = (v: number): string =>
    !Number.isFinite(v)
      ? "—"
      : Math.abs(v) >= 1000
        ? `${(v / 1000).toFixed(2)} kN`
        : `${v.toFixed(1)} N`;
  // the slider's ends are the fleet's useful Froude band — a speed, not a fixed number of knots
  const lwl = solved?.hulls[0]?.cp.wettedLength;
  const [uLo, uHi] = usefulSpeeds(lwl ?? 4);
  const kMin = Math.max(0.1, uLo / KNOT),
    kMax = uHi / KNOT;
  const outOfRange = res ? !inUsefulRange(res.froude) : false;
  const unconverged = solved
    ? solved.hulls.some((h) => h.resolution && !h.resolution.converged)
    : false;
  const perWave = solved?.hulls[0]?.resolution?.perCycleLong;
  const nSlots = pair ? 2 : 1;
  const sep = Math.abs(metas[1].at.dy - metas[0].at.dy);
  const stag = metas[1].at.dx - metas[0].at.dx;
  const cp0 = solved?.hulls[0]?.cp;

  return (
    <div className="mapp">
      <TopBar>
        <strong>Wave pattern</strong>
        <span className="mmuted">
          Michell&rsquo;s integral · thin-ship wave resistance
        </span>
        <span className="spacer" />
        <a className="mlink" href="./library.html">
          Library
        </a>
      </TopBar>
      <div className="mmain">
        <div className="mside">
          <div className="card">
            <div className="cap">
              Speed{!fresh && <span className="val">solving…</span>}
            </div>
            <label
              className="ctl"
              title={`Speed through the water. The range is the fleet's useful Froude band, Fn ${USEFUL_FROUDE[0]}–${USEFUL_FROUDE[1]}: below it wave-making is a negligible part of the total resistance, above it the hulls are planing and thin-ship theory does not apply.`}
            >
              <input
                type="range"
                min={kMin}
                max={kMax}
                step={(kMax - kMin) / 200}
                value={Math.min(kMax, Math.max(kMin, knots))}
                onChange={(e) => setKnots(+e.target.value)}
              />
              <span className="ctlval">{knots.toFixed(1)} kn</span>
            </label>
            <div className="mrow">
              <span>Froude number</span>
              <b className={outOfRange ? "warn" : ""}>
                {res ? res.froude.toFixed(3) : "—"}
              </b>
            </div>
            <div className="mrow">
              <span>Transverse wavelength</span>
              <b>
                {solved && fresh
                  ? `${((2 * Math.PI) / solved.nu).toFixed(2)} m`
                  : "—"}
              </b>
            </div>
            <label className="ctl mcheck">
              <input
                type="checkbox"
                checked={salt}
                onChange={(e) => setSalt(e.target.checked)}
              />
              Salt water
            </label>
            <label className="ctl mcheck">
              <input
                type="checkbox"
                checked={pair}
                onChange={(e) => setPair(e.target.checked)}
              />
              Two hulls
            </label>
          </div>

          {metas.slice(0, nSlots).map((m, k) => (
            <div className="card" key={k}>
              <div className="cap">
                <span>
                  <span className={"mdot m" + k} /> Hull {k === 0 ? "A" : "B"}
                </span>
              </div>
              <select
                className="msel"
                value={m.id ?? ""}
                onChange={(e) => loadInto(k, e.target.value || null)}
              >
                <option value="">default hull</option>
                {rows.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name || "untitled"}
                  </option>
                ))}
              </select>
              {(m.err ?? sampled?.errs[k]) && (
                <div className="merr">{m.err ?? sampled?.errs[k]}</div>
              )}
              <div className="mrow">
                <span>Standalone R_w</span>
                <b>{res ? fmtN(res.standalone[k] ?? NaN) : "—"}</b>
              </div>
              <div className="mrow msub">
                <span>Position (x, y)</span>
                <b>
                  {m.at.dx.toFixed(2)}, {m.at.dy.toFixed(2)} m
                </b>
              </div>
            </div>
          ))}

          <div className="card">
            <div className="cap">Fleet</div>
            <div className="mrow">
              <span>Combined R_w</span>
              <b>{res ? fmtN(res.rw) : "—"}</b>
            </div>
            <div className="mrow">
              <span>Interference factor</span>
              <b className={res && res.interference < 1 ? "good" : ""}>
                {res ? res.interference.toFixed(4) : "—"}
              </b>
            </div>
            <div className="mrow">
              <span>Effective power</span>
              <b>
                {res && solved
                  ? `${((res.rw * solved.U) / 1000).toFixed(2)} kW`
                  : "—"}
              </b>
            </div>
            {pair && (
              <div className="mrow msub">
                <span>Separation · stagger</span>
                <b>
                  {sep.toFixed(2)} · {stag.toFixed(2)} m
                </b>
              </div>
            )}
            <Button onClick={bringIntoView} disabled={!solved || !fresh}>
              Bring hulls into view
            </Button>
            {pair && <Button onClick={resetPlacement}>Reset placement</Button>}
          </div>

          <div className="card">
            <div className="cap">Hull A geometry</div>
            <div className="mrow msub">
              <span>LWL · draft · beam</span>
              <b>
                {cp0
                  ? `${cp0.wettedLength.toFixed(2)} · ${cp0.draft.toFixed(2)} · ${cp0.beamMax.toFixed(2)} m`
                  : "—"}
              </b>
            </div>
            <div className="mrow msub">
              <span>Displacement ∇</span>
              <b>{cp0 ? `${(2 * cp0.volumeHalf).toFixed(3)} m³` : "—"}</b>
            </div>
            <div className="mrow msub">
              <span>Sample · field</span>
              <b>
                {sampled ? sampled.ms.toFixed(0) : "—"} ms ·{" "}
                {solved && fresh ? solved.ms.toFixed(0) : "—"} ms
              </b>
            </div>
            {/* nodes per wavelength of the kernel: the number that decides whether R_w means anything, and
                the one whose absence made a low-speed answer look converged when it was not */}
            <div className="mrow msub">
              <span>Nodes · θ angles · per wave</span>
              <b className={unconverged ? "warn" : ""}>
                {cp0?.nodes ?? 0} ·{" "}
                {solved && fresh ? solved.grid.theta.length : 0} ·{" "}
                {perWave === undefined ? "—" : perWave.toFixed(1)}
              </b>
            </div>
          </div>
        </div>

        <div className="mfield" ref={fieldPane}>
          <div className="mcanvasctl" aria-label="Canvas zoom controls">
            <button
              type="button"
              onClick={() => changeZoom(zoom / 1.25)}
              disabled={zoom <= 1}
              title="Zoom out"
            >
              −
            </button>
            <span>{Math.round(zoom * 100)}%</span>
            <button
              type="button"
              onClick={() => changeZoom(zoom * 1.25)}
              disabled={zoom >= 4}
              title="Zoom in"
            >
              +
            </button>
          </div>
          <canvas
            ref={canvas}
            className="mcanvas"
            style={{ width: `${zoom * 100}%` }}
            onPointerDown={onPointerDown}
            onWheel={(event) => {
              if (!event.ctrlKey && !event.metaKey) return;
              event.preventDefault();
              changeZoom(zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15));
            }}
            title="Drag a hull to move it; Ctrl/⌘ + wheel to zoom"
          />
          <div className="mlegend">
            <span>trough</span>
            <i
              style={{ background: `linear-gradient(to right, ${rampCss()})` }}
            />
            <span>crest</span>
            <span className="mhint">drag a hull to reposition it</span>
          </div>
          {(outOfRange || unconverged) && (
            <div className="mwarn">
              {outOfRange
                ? `Fn ${res!.froude.toFixed(2)} is outside Fn ${USEFUL_FROUDE[0]}–${USEFUL_FROUDE[1]}, where this is worth reporting: below it wave-making is a negligible part of the total, above it the hulls are planing and thin-ship theory has no dynamic lift. Treat these numbers as indicative only. `
                : ""}
              {unconverged
                ? `The sampling could not resolve the kernel at this speed (${perWave === undefined ? "—" : perWave.toFixed(1)} nodes per wave, ${NODES_PER_CYCLE} needed) — R_w is not converged.`
                : ""}
            </div>
          )}
          {res && <SpectrumPlot result={res} />}
          <div className="mnote">
            Wave-making resistance only — no viscous drag, no sinkage or trim.
            Thin-ship theory: the hull is replaced by its centreplane
            projection, so accuracy falls off as beam/length grows. What is
            drawn is the far-field free-wave pattern — physical astern of the
            hulls, faded where it is not. Placement changes the picture and the
            resistance exactly, and nothing is re-solved when it does: thin-ship
            amplitudes superpose, so a hull that moves carries only a phase.
          </div>
        </div>
      </div>
    </div>
  );
}

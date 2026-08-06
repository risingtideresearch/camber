import { useEffect, useRef } from "react";

// ---------- the resistance curve ----------
//
// Resistance against speed, with the total broken into the parts that make it. The decomposition is the
// point of the picture, not decoration: viscous drag is a smooth power law that no hull shape moves much,
// while wave-making is the part the sheer line and the sections are actually being drawn to control. Seeing
// them separately is what tells you whether a change to the hull can help at the speed you care about.
//
// TWO WAVE CURVES ARE DRAWN, AND THEY ARE NOT MEANT TO AGREE. Holtrop's is a regression over a few hundred
// towing-tank hulls: right on average, and blind to the specific hull on screen — it cannot see a hollow put
// there on purpose, because its inputs are only bulk coefficients. Michell's is an integral over THIS hull's
// centreplane: it sees every change made to the shape, and its accuracy falls off as beam/length grows,
// because thin-ship theory assumes a hull narrow compared to its length. So Holtrop sets the level and
// Michell shows the shape — the humps and hollows, and which way an edit moves them. Their disagreement is
// information, which is why neither is quietly folded into the other.
//
// On a beamy hull the two can be a long way apart, and the Michell curve can run clean over the total: on
// camber's default hull (B/L = 0.38, which is not thin by any measure) it does so across most of the range.
// That is not a bug to hide behind a rescale — it is the theory reporting that it is outside its envelope,
// and the panel says so in as many words. The log axis is what keeps both curves readable when they differ
// by an order of magnitude.
//
// The Michell curve arrives point by point from the worker (it is seconds of work at the slow end), so it is
// drawn from whatever has landed so far and simply grows. Points that came back under-resolved are marked
// rather than dropped: at the slow end of the range the sampling can lose the kernel, and a curve that hid
// that would look converged everywhere.

export interface CurvePoint {
  kn: number;
  total: number; // blended total resistance (N)
  viscous: number; // Holtrop R_visc + R_A (N)
  waveHoltrop: number; // Holtrop R_W (N)
  planingWeight: number;
}

export interface MichellPoint {
  kn: number;
  rw: number; // N
  converged: boolean;
}

interface ResistancePlotProps {
  curve: CurvePoint[];
  michell: MichellPoint[];
  logY: boolean;
  hover: number | null; // hovered speed in knots, or null
  onHover: (kn: number | null) => void;
}

const H = 190; // CSS px
const PAD = { l: 40, r: 8, t: 10, b: 20 };

const COLORS = {
  total: "#1a202c",
  viscous: "#0f766e",
  waveHoltrop: "#dd6b20",
  michell: "#2b6cb0",
};

// A round step for an axis: 1, 2, 5 × a power of ten, chosen so the axis gets roughly `want` ticks.
function niceStep(span: number, want: number): number {
  if (!(span > 0)) return 1;
  const raw = span / Math.max(1, want),
    mag = 10 ** Math.floor(Math.log10(raw)),
    n = raw / mag;
  return (n > 5 ? 10 : n > 2 ? 5 : n > 1 ? 2 : 1) * mag;
}

export function ResistancePlot({
  curve,
  michell,
  logY,
  hover,
  onHover,
}: ResistancePlotProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const c = ref.current;
    if (!c || !curve.length) return;
    const dpr = devicePixelRatio || 1;
    const cssW = c.clientWidth || 300;
    c.width = Math.round(cssW * dpr);
    c.height = Math.round(H * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, H);

    const x0 = curve[0].kn,
      x1 = curve[curve.length - 1].kn;
    // The y-axis is set by the TOTAL alone. Michell can run well above it on a beamy hull, and letting that
    // rescale the axis would squash the curve everyone is actually reading down into the bottom of the
    // frame. Whatever runs off the top is clipped instead, and the panel warns about it in words.
    let yMax = 0,
      yMin = Infinity;
    for (const p of curve) {
      yMax = Math.max(yMax, p.total);
      if (p.total > 0) yMin = Math.min(yMin, p.total);
    }
    if (!(yMax > 0)) return;

    const W = cssW - PAD.l - PAD.r,
      Hp = H - PAD.t - PAD.b;
    const px = (kn: number): number =>
      PAD.l + ((kn - x0) / Math.max(1e-9, x1 - x0)) * W;

    // A hull's resistance covers DECADES between the bottom and the top of its speed range — on a small
    // planing hull, tens of newtons at Fn 0.1 and thousands at Fn 1.0. On a linear axis everything below
    // hull speed is a flat line on the floor, which is exactly the range a displacement hull is designed
    // for. So the axis defaults to log, where a fixed vertical distance means the same RATIO everywhere and
    // the hollows at the bottom of the range are as readable as the hump at the top. Linear is still a
    // click away, because it is the form a resistance curve is conventionally published in and it is the
    // one that shows how much of the total the hump really is.
    const decades = logY
      ? {
          lo: 10 ** Math.floor(Math.log10(Math.max(yMin, yMax / 1e5))),
          hi: 10 ** Math.ceil(Math.log10(yMax)),
        }
      : null;
    const step = niceStep(yMax, 4);
    const linMax = Math.ceil(yMax / step) * step;
    const py = decades
      ? (r: number): number =>
          PAD.t +
          Hp -
          (Math.log10(Math.max(r, decades.lo * 1e-3) / decades.lo) /
            Math.log10(decades.hi / decades.lo)) *
            Hp
      : (r: number): number => PAD.t + Hp - (r / linMax) * Hp;
    // the gridline values: one per decade in log, one per round step in linear
    const ticks: number[] = [];
    if (decades)
      for (let v = decades.lo; v <= decades.hi * 1.000001; v *= 10)
        ticks.push(v);
    else for (let v = 0; v <= linMax + 1e-9; v += step) ticks.push(v);

    // ---- the planing blend band ----
    // Where the answer is a crossfade between two methods rather than either one of them. Shown because a
    // number read inside it is a different kind of number from one read outside it.
    const blend = curve.filter((p) => p.planingWeight > 0.001);
    if (blend.length > 1) {
      ctx.fillStyle = "rgba(124,58,237,0.07)";
      const a = px(blend[0].kn);
      ctx.fillRect(a, PAD.t, px(blend[blend.length - 1].kn) - a, Hp);
    }

    // ---- axes ----
    ctx.font = "10px -apple-system, system-ui, sans-serif";
    ctx.strokeStyle = "rgba(148,163,184,0.35)";
    ctx.fillStyle = "#718096";
    ctx.lineWidth = 1;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const label = (r: number): string =>
      r >= 1000
        ? `${r / 1000 >= 10 ? r / 1000 : (r / 1000).toFixed(1)}k`
        : `${Math.round(r)}`;
    for (const r of ticks) {
      const y = Math.round(py(r)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(PAD.l, y);
      ctx.lineTo(cssW - PAD.r, y);
      ctx.stroke();
      ctx.fillText(label(r), PAD.l - 5, y);
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    const knStep = niceStep(x1 - x0, 5);
    for (let k = Math.ceil(x0 / knStep) * knStep; k <= x1 + 1e-9; k += knStep) {
      const x = Math.round(px(k)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, PAD.t);
      ctx.lineTo(x, PAD.t + Hp);
      ctx.stroke();
      ctx.fillText(`${k}`, x, H - 6);
    }

    // ---- curves ----
    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD.l, PAD.t - 1, W, Hp + 2);
    ctx.clip(); // keeps an over-running Michell tail inside the frame instead of over the axis labels
    const line = (
      pts: { x: number; y: number }[],
      color: string,
      width: number,
      dash: number[] = [],
    ): void => {
      if (pts.length < 2) return;
      ctx.setLineDash(dash);
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineJoin = "round";
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
      ctx.setLineDash([]);
    };
    const of = (pick: (p: CurvePoint) => number): { x: number; y: number }[] =>
      curve.map((p) => ({ x: px(p.kn), y: py(pick(p)) }));

    line(
      of((p) => p.viscous),
      COLORS.viscous,
      1.2,
    );
    line(
      of((p) => p.waveHoltrop),
      COLORS.waveHoltrop,
      1.2,
    );
    line(
      of((p) => p.total),
      COLORS.total,
      2,
    );

    const mich = [...michell].sort((a, b) => a.kn - b.kn);
    line(
      mich.map((p) => ({ x: px(p.kn), y: py(p.rw) })),
      COLORS.michell,
      1.4,
      [4, 3],
    );
    // the samples themselves, so a curve still filling in reads as points-so-far rather than as a coarse
    // answer; hollow where the grid could not resolve the kernel at that speed
    for (const p of mich) {
      const x = px(p.kn),
        y = py(p.rw);
      ctx.beginPath();
      ctx.arc(x, y, 2.2, 0, 2 * Math.PI);
      if (p.converged) {
        ctx.fillStyle = COLORS.michell;
        ctx.fill();
      } else {
        ctx.strokeStyle = COLORS.michell;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
    }

    // ---- the hovered speed ----
    if (hover != null) {
      const x = Math.round(px(hover)) + 0.5;
      ctx.strokeStyle = "#e11d48";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, PAD.t);
      ctx.lineTo(x, PAD.t + Hp);
      ctx.stroke();
    }
    ctx.restore();
  }, [curve, michell, logY, hover]);

  const toKn = (e: React.MouseEvent<HTMLCanvasElement>): number | null => {
    const c = ref.current;
    if (!c || !curve.length) return null;
    const rect = c.getBoundingClientRect();
    const W = rect.width - PAD.l - PAD.r;
    if (W <= 0) return null;
    const x0 = curve[0].kn,
      x1 = curve[curve.length - 1].kn;
    const t = (e.clientX - rect.left - PAD.l) / W;
    return x0 + Math.min(1, Math.max(0, t)) * (x1 - x0);
  };

  return (
    <canvas
      ref={ref}
      className="rescv"
      style={{ height: H }}
      onMouseMove={(e) => onHover(toKn(e))}
      onMouseLeave={() => onHover(null)}
    />
  );
}

export const CURVE_COLORS = COLORS;

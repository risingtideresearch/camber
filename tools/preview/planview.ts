// Faithful rasterizer of the editor's PLAN strip (uses the real view.ts mappings), to check the extended
// below-centerline band, the sheer-plan curve crossing the centerline, the max-beam line, and the cps.
import { Resvg } from "@resvg/resvg-js";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  state,
  L,
  resetModel,
  prepare,
  sweptSection,
  forwardLimit,
} from "../../src/core/model";
import { loadJsonText } from "../../src/core/json";
import { mapX, yPlan, LH, Lbase, PXpad, YMAX } from "../../src/core/view";

resetModel();
if (process.env.CAMBER_DOC)
  loadJsonText(readFileSync(process.env.CAMBER_DOC, "utf8"));
prepare();

const xFwd = forwardLimit();
const poly = (pts: [number, number][]) =>
  pts
    .map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`)
    .join(" ");
const path = (d: string, c: string, w: number, extra = "") =>
  `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" ${extra}/>`;

let body = `<rect x="0" y="0" width="1000" height="${LH}" fill="#fff"/>`;
// centerline (y=0) + LOA marker + the below-centerline band shaded faintly
body += `<rect x="${PXpad}" y="${Lbase.toFixed(1)}" width="${1000 - 2 * PXpad}" height="${(LH - 18 - Lbase).toFixed(1)}" fill="#0f766e" opacity="0.05"/>`;
body += `<line x1="${PXpad}" y1="${Lbase.toFixed(1)}" x2="${1000 - PXpad}" y2="${Lbase.toFixed(1)}" stroke="#0f766e" stroke-width="1" stroke-dasharray="4 4"/>`;
body += `<line x1="${mapX(L).toFixed(1)}" y1="6" x2="${mapX(L).toFixed(1)}" y2="${(LH - 6).toFixed(1)}" stroke="#94a3b8" stroke-width="0.8" stroke-dasharray="2 3"/>`;

// sheer plan curve (orange) — only out to the last control point (no extrapolation)
const xEndP = state.sheer.cp[state.sheer.cp.length - 1].x;
const xs: number[] = [];
for (let i = 0; i <= 110; i++) xs.push((xEndP * i) / 110);
body += path(
  poly(xs.map((x) => [mapX(x), yPlan(state.sheer.yf(x))])),
  "#dd6b20",
  2,
  'stroke-linejoin="round" opacity="0.8" stroke-dasharray="8 5"',
);
// max-beam (violet)
const beam: [number, number][] = [];
for (let i = 0; i <= 200; i++) {
  const x = (xFwd * i) / 200,
    s = sweptSection(x, 24, true, false);
  if (s.aft) continue;
  let my = -1e9;
  for (const p of s.pts) my = Math.max(my, p[1]);
  beam.push([mapX(x), yPlan(my)]);
}
body += path(poly(beam), "#7c3aed", 2.4, 'stroke-linejoin="round"');
// control points
for (const cp of state.sheer.cp)
  body += `<circle cx="${mapX(cp.x).toFixed(1)}" cy="${yPlan(cp.y).toFixed(1)}" r="4" fill="#dd6b20"/>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 ${LH}" width="1400">${body}</svg>`;
const out = process.argv[2] || "out/planview.png";
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, new Resvg(svg).render().asPng());
console.log(
  `wrote ${out}  LH=${LH.toFixed(0)} Lbase=${Lbase.toFixed(0)} forwardLimit=${xFwd.toFixed(0)} YMAX=${YMAX}`,
);

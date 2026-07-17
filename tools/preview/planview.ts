// Faithful rasterizer of the editor's PLAN strip (uses the real view.ts mappings), to check the extended
// below-centerline band, the sheer-plan curve crossing the centerline, the max-beam line, and the cps.
import { Resvg } from "@resvg/resvg-js";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  createModel,
  loa,
  bounds,
  resetModel,
  prepare,
} from "../../src/core/model";
import { sweptSection, forwardLimit } from "../../src/core/mesh";
import { loadJsonText } from "../../src/core/json";
import { viewOf, PXpad } from "../../src/core/view";

const model = createModel();

resetModel(model);
if (process.env.CAMBER_DOC)
  loadJsonText(model, readFileSync(process.env.CAMBER_DOC, "utf8"));
prepare(model);

// the view transforms follow the hull's own length now, so they are derived from the model rather than
// imported as module constants
const V = viewOf(model),
  { mapX, yPlan, lh: LH, lbase: Lbase } = V,
  L = loa(model),
  YMAX = bounds(model).yMax;
const uFwd = forwardLimit(model);
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

// sheer plan curve (orange), sampled in its own parameter — it is a parametric curve, not a graph, so it
// can be drawn crossing the centerline at a tumblehome bow
const pl: [number, number][] = [];
for (let i = 0; i <= 160; i++) {
  const [px, py] = model.plan.at(i / 160);
  pl.push([mapX(px), yPlan(py)]);
}
body += path(
  poly(pl),
  "#dd6b20",
  2,
  'stroke-linejoin="round" opacity="0.8" stroke-dasharray="8 5"',
);
// max-beam (violet)
const beam: [number, number][] = [];
for (let i = 0; i <= 200; i++) {
  const s = sweptSection(model, (uFwd * i) / 200, 6, true);
  if (s.empty) continue;
  let p = s.pts[0];
  for (const q of s.pts) if (q[1] > p[1]) p = q;
  beam.push([mapX(p[0]), yPlan(p[1])]);
}
body += path(poly(beam), "#7c3aed", 2.4, 'stroke-linejoin="round"');
// control points
for (const cp of model.sheerPlan)
  body += `<circle cx="${mapX(cp.x).toFixed(1)}" cy="${yPlan(cp.y).toFixed(1)}" r="4" fill="#dd6b20"/>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 ${LH}" width="1400">${body}</svg>`;
const out = process.argv[2] || "out/planview.png";
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, new Resvg(svg).render().asPng());
console.log(
  `wrote ${out}  loa=${L} ${model.unit} LH=${LH.toFixed(0)} Lbase=${Lbase.toFixed(0)} forwardLimit u=${uFwd.toFixed(3)} YMAX=${YMAX.toFixed(0)}`,
);

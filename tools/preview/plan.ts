// Offline rasterizer for the 2D PLAN view (half-breadth from above): the sheer-plan curve (deck edge),
// the WIDEST-POINT (max-beam) longitudinal, and the centerline — to see whether the widest line fairs into
// the stem. CAMBER_DOC=/path.json node plan.mjs [out.png]
import { Resvg } from "@resvg/resvg-js";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { loa } from "../../src/core/model";
import { sweptSection, forwardLimit } from "../../src/core/mesh";
import { parseHullState } from "../../src/core/json";
import { assemble } from "../../src/core/runtime";
import { defaultHull } from "../../src/core/hull";

const doc = process.env.CAMBER_DOC;
const model = assemble(
  doc ? parseHullState(readFileSync(doc, "utf8")) : defaultHull(),
);

// the hull spans the plan's own parameter u, so both curves are sampled in it and read out in x — the plan
// is a parametric curve now, not a graph, which is also what lets it be drawn crossing the centerline
const L = loa(model);
const uFwd = forwardLimit(model),
  xFwd = model.plan.at(uFwd)[0];
const sheerPts: [number, number][] = []; // (x, y) deck edge
const maxBeam: [number, number][] = []; // (x, max y of the section)
const N = 200;
for (let i = 0; i <= N; i++) {
  const u = (uFwd * i) / N;
  const [px, py] = model.plan.at(u);
  sheerPts.push([px, py]);
  const s = sweptSection(model, u, 6, true);
  if (s.empty) continue;
  let my = -1e9,
    mx = px;
  for (const q of s.pts)
    if (q[1] > my) {
      my = q[1];
      mx = q[0];
    }
  maxBeam.push([mx, my]);
}

// scale: x across width, y (half-breadth) vertical with the centerline near the bottom; allow a little y<0
const W = 1400,
  H = 420,
  padL = 20,
  padR = 20,
  padT = 20,
  padB = 60;
const xs = (x: number) => padL + (x / xFwd) * (W - padL - padR);
const ymin = -0.08 * L,
  ymax = Math.max(...maxBeam.map((p) => p[1])) * 1.05;
const ysc = (y: number) =>
  H - padB - ((y - ymin) / (ymax - ymin)) * (H - padT - padB);
const poly = (pts: [number, number][]) =>
  pts
    .map(
      (p, i) =>
        `${i ? "L" : "M"}${xs(p[0]).toFixed(1)} ${ysc(p[1]).toFixed(1)}`,
    )
    .join(" ");
const path = (d: string, c: string, w: number, extra = "") =>
  `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round" ${extra}/>`;

let body = `<rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>`;
// centerline (y=0) and the LOA marker
body += `<line x1="${xs(0)}" y1="${ysc(0)}" x2="${xs(xFwd)}" y2="${ysc(0)}" stroke="#0f766e" stroke-width="1" stroke-dasharray="4 4"/>`;
body += `<line x1="${xs(L)}" y1="${padT}" x2="${xs(L)}" y2="${H - padB}" stroke="#94a3b8" stroke-width="0.8" stroke-dasharray="2 3"/>`;
body += `<text x="${xs(L) + 3}" y="${H - padB - 4}" font-size="11" fill="#94a3b8">LOA</text>`;
body += path(poly(maxBeam), "#0f766e", 2.4); // widest-point longitudinal (teal)
body += path(poly(sheerPts), "#dd6b20", 2.4); // sheer plan / deck edge (orange)
// control points of the sheer plan
for (const cp of model.sheerPlan)
  body += `<circle cx="${xs(cp.x).toFixed(1)}" cy="${ysc(cp.y).toFixed(1)}" r="3.5" fill="#dd6b20"/>`;
body += `<text x="${padL}" y="${H - 8}" font-size="12" fill="#dd6b20">sheer plan (deck edge)</text>`;
body += `<text x="${padL + 200}" y="${H - 8}" font-size="12" fill="#0f766e">widest point (max beam)</text>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}">${body}</svg>`;
const out = process.argv[2] || "out/plan.png";
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, new Resvg(svg).render().asPng());
console.log(
  `wrote ${out}  loa=${L} ${model.unit}  forwardLimit u=${uFwd.toFixed(3)} (x=${xFwd.toFixed(0)})`,
);

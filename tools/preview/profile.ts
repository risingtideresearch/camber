// Offline rasterizer for the 2D PROFILE view (side elevation): keel/rocker line, sheer-trim line, transom,
// deck and DWL — so the keel↔trim↔transom meeting can be seen without a browser. Mirrors render.ts drawProfile.
//   CAMBER_DOC=/path/to.json node profile.mjs [out.png]
import { Resvg } from "@resvg/resvg-js";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { loa } from "../../src/core/model";
import {
  computeHullSampling,
  forwardLimit,
  transomOutline,
} from "../../src/core/mesh";
import { parseHullState } from "../../src/core/json";
import { assemble } from "../../src/core/runtime";
import { defaultHull } from "../../src/core/hull";
import type { Vec3 } from "../../src/core/math";
import { viewOf } from "../../src/core/view";

const doc = process.env.CAMBER_DOC;
const model = assemble(
  doc ? parseHullState(readFileSync(doc, "utf8")) : defaultHull(),
);

// the view transforms follow the hull's own length now, so they come from the model
const V = viewOf(model),
  { mapX, zScreenP, ph: PH } = V,
  L = loa(model);

const poly = (pts: [number, number][]): string =>
  pts
    .map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`)
    .join(" ");
const path = (d: string, stroke: string, w: number, extra = ""): string =>
  `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round" ${extra}/>`;

// the hull, sampled exactly the way the editor samples it — one shared lattice, trimmed, with a column placed
// at each end closure and at the transom's foot. Everything below is read off those columns, so this picture
// is of the same geometry the app draws rather than of a second sampling that merely resembles it.
const NSEC = 80,
  uFwd = forwardLimit(model),
  xFwd = model.plan.at(uFwd)[0],
  sampling = computeHullSampling(model, NSEC, 4);

let body = "";
// deck reference z=0
body += `<line x1="${mapX(0)}" y1="${zScreenP(0)}" x2="${mapX(L)}" y2="${zScreenP(0)}" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="2 4"/>`;

// DWL (blue), all the way forward to the closure
const wlS = Math.sin(model.deckRake),
  wlC = Math.cos(model.deckRake);
const zWL = (x: number) => (-model.waterline - x * wlS) / wlC;
body += `<line x1="${mapX(0)}" y1="${zScreenP(zWL(0))}" x2="${mapX(xFwd)}" y2="${zScreenP(zWL(xFwd))}" stroke="#0ea5e9" stroke-width="1.8"/>`;

// keel + stem (green): the mesh's own centerline edge in marched order — foot, rocker, forefoot, then up the
// stem to the corner it shares with the sheer. A bow that never closes onto the centerline has no such
// corner, and the outline ends on the trim at the stem instead.
const keel: Vec3[] = sampling.hullCenterline.map((s) => s.pos);
const te = transomOutline(sampling);
if (
  keel.length &&
  sampling.hullCenterline[keel.length - 1] !==
    sampling.hullSheer[sampling.hullSheer.length - 1]
)
  keel.push([xFwd, 0, model.trimZ(xFwd)]);
body += path(
  poly(keel.map((p) => [mapX(p[0]), zScreenP(p[2])])),
  "#0f766e",
  2.4,
);

// sheer trim (orange) over its own x domain — there is no bow overhang to extend past any more: the hull
// spans exactly the plan, and a tumblehome bow is closed by dragging the plan across the centerline
const tx0 = model.sheerTrim[0].x,
  tx1 = model.sheerTrim[model.sheerTrim.length - 1].x;
const xs: number[] = [];
for (let i = 0; i <= 110; i++) xs.push(tx0 + ((tx1 - tx0) * i) / 110);
body += path(
  poly(xs.map((x) => [mapX(x), zScreenP(model.trimZ(x))])),
  "#dd6b20",
  2.4,
);
// trim control polygon (faint)
body += path(
  poly(model.sheerTrim.map((cp) => [mapX(cp.x), zScreenP(cp.z)])),
  "#dd6b20",
  1,
  'opacity="0.4" stroke-dasharray="3 4"',
);

// transom edge (blue)
if (te.length)
  body += path(
    poly(te.map((p) => [mapX(p[0]), zScreenP(p[2])])),
    "#b45309",
    2.4,
  );

// vertical guide at x=L
body += `<line x1="${mapX(L)}" y1="0" x2="${mapX(L)}" y2="${PH}" stroke="#94a3b8" stroke-width="0.7" stroke-dasharray="2 3"/>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 ${PH}" width="1400"><rect x="0" y="0" width="1000" height="${PH}" fill="#fff"/>${body}</svg>`;
const out = process.argv[2] || "out/profile.png";
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, new Resvg(svg).render().asPng());
console.log(
  `wrote ${out}  loa=${L} ${model.unit}  forwardLimit u=${uFwd.toFixed(3)} (x=${xFwd.toFixed(0)})  keelPts=${keel.length}`,
);

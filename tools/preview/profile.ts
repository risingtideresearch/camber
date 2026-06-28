// Offline rasterizer for the 2D PROFILE view (side elevation): keel/rocker line, sheer-trim line, transom,
// deck and DWL — so the keel↔trim↔transom meeting can be seen without a browser. Mirrors render.ts drawProfile.
//   CAMBER_DOC=/path/to.json node profile.mjs [out.png]
import { Resvg } from "@resvg/resvg-js";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { state, L, resetModel, prepare, clippedSection, forwardLimit, transomEdge, type Vec3 } from "../../src/model.js";
import { loadJsonText } from "../../src/json.js";
import { mapX, zScreenP, PH } from "../../src/view.js";

const doc = process.env.CAMBER_DOC;
resetModel();
if (doc) loadJsonText(readFileSync(doc, "utf8"));
prepare();

const poly = (pts: [number, number][]): string =>
  pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
const path = (d: string, stroke: string, w: number, extra = ""): string =>
  `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round" ${extra}/>`;

// sections to the forward closure, cosine-clustered (same as render.ts)
const NSEC = 80, xFwd = forwardLimit(), sections: any[] = [];
for (let i = 0; i <= NSEC; i++) sections.push(clippedSection((xFwd * (1 - Math.cos((Math.PI * i) / NSEC))) / 2, 18));

let body = "";
// deck reference z=0
body += `<line x1="${mapX(0)}" y1="${zScreenP(0)}" x2="${mapX(L)}" y2="${zScreenP(0)}" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="2 4"/>`;

// DWL (blue), all the way forward to the closure
const wlS = Math.sin(state.deckRake), wlC = Math.cos(state.deckRake);
const zWL = (x: number) => (-state.waterline - x * wlS) / wlC;
body += `<line x1="${mapX(0)}" y1="${zScreenP(zWL(0))}" x2="${mapX(xFwd)}" y2="${zScreenP(zWL(xFwd))}" stroke="#0ea5e9" stroke-width="1.8"/>`;

// keel + stem (green), matching the mesh: keel rises to the forefoot, then the diving top edge back to the trim
const closing = sections.filter((s) => s.keel && s.pts.length > 1);
const keel = closing.map((s) => s.pts[s.pts.length - 1] as Vec3);
const te = transomEdge();
if (keel.length) {
  if (te.length) keel.unshift(te[te.length - 1]);
  const dived = (s: any) => s.pts[0][2] < state.sheer.zf(s.pts[0][0]) - 3;
  let b = closing.length;
  while (b > 0 && dived(closing[b - 1])) b--;
  const stem = closing.slice(b).map((s) => s.pts[0] as Vec3);
  if (stem.length) for (let i = stem.length - 1; i >= 0; i--) keel.push(stem[i]);
  else keel.push([xFwd, 0, state.sheer.zf(xFwd)]);
}
body += path(poly(keel.map((p) => [mapX(p[0]), zScreenP(p[2])])), "#0f766e", 2.4);

// sheer trim (orange) over [0, L+overhang]
const xs: number[] = [];
for (let i = 0; i <= 110; i++) xs.push(((L + 400) * i) / 110);
body += path(poly(xs.map((x) => [mapX(x), zScreenP(state.sheer.zf(x))])), "#dd6b20", 2.4);
// trim control polygon (faint)
body += path(poly(state.sheer.trim.map((cp: any) => [mapX(cp.x), zScreenP(cp.z)])), "#dd6b20", 1, 'opacity="0.4" stroke-dasharray="3 4"');

// transom edge (blue)
if (te.length) body += path(poly(te.map((p) => [mapX(p[0]), zScreenP(p[2])])), "#b45309", 2.4);

// vertical guide at x=L
body += `<line x1="${mapX(L)}" y1="0" x2="${mapX(L)}" y2="${PH}" stroke="#94a3b8" stroke-width="0.7" stroke-dasharray="2 3"/>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 ${PH}" width="1400"><rect x="0" y="0" width="1000" height="${PH}" fill="#fff"/>${body}</svg>`;
const out = process.argv[2] || "out/profile.png";
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, new Resvg(svg).render().asPng());
console.log(`wrote ${out}  forwardLimit=${xFwd.toFixed(0)}  keelPts=${keel.length}`);

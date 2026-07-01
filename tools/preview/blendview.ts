// Faithful rasterizer of the editor's new HORIZONTAL blend strip (real view.ts mappings) — to verify the
// bands stack vertically, the cp columns line up at mapX(cp.x), and the boundary handles sit at wY(cum).
import { Resvg } from "@resvg/resvg-js";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { state, L, resetModel, prepare, weightsAt } from "../../src/core/model";
import { loadJsonText } from "../../src/core/json";
import { mapX, wY, WH } from "../../src/core/view";

resetModel();
if (process.env.CAMBER_DOC)
  loadJsonText(readFileSync(process.env.CAMBER_DOC, "utf8"));
prepare();

const TPL = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c", "#0891b2"];
const poly = (pts: [number, number][]) =>
  pts
    .map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`)
    .join(" ");

const K = state.templates.length;
const top = wY(1),
  bot = wY(0);
const xEnd = state.sheer.cp[state.sheer.cp.length - 1].x;
const xL = mapX(0),
  xR = mapX(xEnd);

let body = `<rect x="0" y="0" width="1000" height="${WH}" fill="#fff"/>`;
for (const g of [0, 0.5, 1])
  body += `<line x1="${xL}" y1="${wY(g)}" x2="${xR}" y2="${wY(g)}" stroke="#edf2f7" stroke-width="1"/>`;

const NS = 120,
  xs: number[] = [],
  cum: number[][] = [];
for (let i = 0; i <= NS; i++) {
  const x = (xEnd * i) / NS,
    w = weightsAt(x),
    c = [0];
  let s = 0;
  for (let j = 0; j < K; j++) {
    s += w[j];
    c.push(s);
  }
  xs.push(x);
  cum.push(c);
}
for (let j = 0; j < K; j++) {
  const upper = xs.map((x, i): [number, number] => [
    mapX(x),
    wY(cum[i][j + 1]),
  ]);
  const lower = xs
    .map((x, i): [number, number] => [mapX(x), wY(cum[i][j])])
    .reverse();
  body += `<path d="${poly(upper.concat(lower))}Z" fill="${TPL[j % TPL.length]}" opacity="0.5"/>`;
}
for (const cp of state.sheer.cp) {
  const x = mapX(cp.x);
  body += `<line x1="${x}" y1="${top}" x2="${x}" y2="${bot}" stroke="#fff" stroke-width="1" opacity="0.75"/>`;
  let s = 0;
  for (let b = 0; b < K - 1; b++) {
    s += cp.w[b];
    body += `<circle cx="${x}" cy="${wY(s).toFixed(1)}" r="5" fill="#fff" stroke="${TPL[b % TPL.length]}" stroke-width="2"/>`;
  }
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 ${WH}" width="1000" height="${WH}">${body}</svg>`;
const out = process.argv[2] || "out/blend.png";
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out.replace(/\.png$/, ".svg"), svg);
writeFileSync(out, new Resvg(svg, { background: "white" }).render().asPng());
console.log("wrote", out, "K=", K, "xEnd=", xEnd, "L=", L);

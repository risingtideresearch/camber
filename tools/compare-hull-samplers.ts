// ---------- which coordinates make random hulls boats? ----------
//
// Draws hulls from several samplers and scores each draw with `hullSampleMetrics` (does it float, is the deck
// dry, does the bottom close, are the proportions and the fairness inside the envelope real designs occupy).
// Two families of sampler are compared:
//
//   AUTHORED  — the hull's own numbers (`HullState`), each slot perturbed independently around a base hull:
//               positive slots (steps, depths, half-breadths) by a log-normal factor, free slots (inboard
//               offsets, rake, ends) by an additive one. This is "sampling random points" in the format's
//               coordinates, the thing that does not work well.
//   REPARAM   — the ratio coordinates of `src/core/reparam.ts`, θ ~ N(0, T²) around the canonical boat, or
//               around an existing design's own θ (encode, perturb, decode).
//
// and, for reference, the designs people actually saved, scored the same way, and the retired generator in
// `random.ts`. Each sampler also gets a contact sheet (profile, plan and body plan of twelve draws), as SVG
// and — when `@resvg/resvg-js` is installed under tools/preview — PNG.
//
//   npx tsx tools/compare-hull-samplers.ts [--n 200] [--out DIR] [--designs FILE]
//
// `--designs` is a JSON array of `{ name, document }` rows as the library's `designs` table returns them (see
// `src/core/supabase.ts`); with it, the real designs are scored and two of them become bases for the
// around-a-design samplers.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { defaultHull, loa, type HullState } from "../src/core/hull";
import { parseHullState } from "../src/core/json";
import { assemble } from "../src/core/runtime";
import { randomDoc } from "../src/core/random";
import {
  createHullCodec,
  gaussian,
  sampleAround,
  sampleTheta,
} from "../src/core/reparam";
import { seededRandom } from "../src/core/sheet/generateTrials";
import { analyze, summarize, type Scorecard } from "./hullSampleMetrics";
import type { HullSampling } from "../src/core/mesh";
import type { Model } from "../src/core/model";

// ---------- arguments ----------
const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const N = parseInt(arg("n") ?? "150", 10);
const OUT = arg("out") ?? "tools/out/samplers";
const DESIGNS = arg("designs");
mkdirSync(OUT, { recursive: true });

// ---------- the authored-space sampler ----------
// Every slot of the base hull, perturbed on its own. The perturbation respects each slot's domain — a step
// stays positive, a knuckle stays a knuckle — so every draw is a valid hull; what it does not respect is any
// relation between slots.
function authoredJitter(
  base: HullState,
  sigma: number,
  rng: () => number,
): HullState {
  const L = loa(base);
  const pos = (v: number): number => v * Math.exp(sigma * gaussian(rng));
  const free = (v: number, ref: number): number =>
    v + sigma * Math.max(Math.abs(v), ref) * gaussian(rng);
  const chain = (xs: readonly number[]): number[] => {
    const out = [xs[0]];
    for (let i = 1; i < xs.length; i++)
      out.push(out[i - 1] + pos(xs[i] - xs[i - 1]));
    return out;
  };
  const planX = chain(base.sheerPlan.map((p) => p.x)),
    trimX = chain(base.sheerTrim.map((p) => p.x));
  const yMid = base.sheerPlan[Math.floor((base.sheerPlan.length - 1) / 2)].y;
  const [top, bot] = base.transom;
  const xt = free(top.x, 0.05 * L),
    zt = -pos(-top.z || 0.01 * L),
    zb = zt - pos(top.z - bot.z),
    rake = free((bot.x - top.x) / (bot.z - top.z || 1), 0.3);
  return {
    ...base,
    sheerPlan: base.sheerPlan.map((p, i) => ({
      x: planX[i],
      y: p.y > 0 ? pos(p.y) : free(p.y, 0.05 * yMid),
    })),
    sheerTrim: base.sheerTrim.map((p, i) => ({
      x: trimX[i],
      z: -pos(-p.z || 0.002 * L),
      k: p.k,
    })),
    transom: [
      { x: xt, z: zt },
      { x: xt + rake * (zb - zt), z: zb },
    ],
    stations: base.stations.map((st) => {
      const zs = [st.points[0].z];
      for (let i = 1; i < st.points.length; i++)
        zs.push(
          zs[i - 1] - pos(st.points[i - 1].z - st.points[i].z || 1e-6 * L),
        );
      return {
        u: st.u,
        keelK: st.keelK,
        points: st.points.map((p, i) => ({
          n: i === 0 ? p.n : free(p.n, 0.05 * L),
          z: zs[i],
          k: p.k,
        })),
      };
    }),
    waterline: pos(base.waterline),
  };
}

// ---------- drawing a contact sheet ----------
interface Drawn {
  card: Scorecard;
  model?: Model;
  sampling?: HullSampling;
  hull: HullState;
  label: string;
}

function cellSvg(
  d: Drawn,
  ox: number,
  oy: number,
  W: number,
  H: number,
): string {
  const L = loa(d.hull),
    s = (W - 160) / L; // the profile and plan span the cell's left part; the body plan sits at the right
  const fmt = (v: number): string => v.toFixed(1);
  const path = (pts: [number, number][], stroke: string, w = 1): string =>
    pts.length < 2
      ? ""
      : `<path d="${pts.map((p, i) => `${i ? "L" : "M"}${fmt(p[0])} ${fmt(p[1])}`).join("")}" fill="none" stroke="${stroke}" stroke-width="${w}" stroke-linejoin="round"/>`;
  const color = d.card.boat ? "#16a34a" : d.card.floats ? "#d97706" : "#dc2626";
  let body = `<rect x="${ox}" y="${oy}" width="${W}" height="${H}" fill="#fff" stroke="#e5e7eb"/>`;
  body += `<text x="${ox + 6}" y="${oy + 13}" font-family="Helvetica,Arial" font-size="10" fill="${color}">${d.label}</text>`;
  if (!d.sampling || !d.model)
    return (
      body +
      `<text x="${ox + 6}" y="${oy + 30}" font-size="10" fill="#dc2626">no geometry</text>`
    );
  const sm = d.sampling,
    x0 = d.hull.sheerPlan[0].x;
  // profile: x right, z up; the deck at a fixed height
  const pz0 = oy + 60;
  const prof = (p: [number, number, number]): [number, number] => [
    ox + 8 + (p[0] - x0) * s,
    pz0 - p[2] * s,
  ];
  body += path(
    sm.hullSheer.map((h) => prof(h.pos)),
    "#334155",
  );
  body += path(
    sm.hullCenterline.map((h) => prof(h.pos)),
    "#0f766e",
    1.2,
  );
  body += path(
    sm.hullTransom.map((h) => prof(h.pos)),
    "#334155",
  );
  const wlz = pz0 + d.hull.waterline * s;
  body += `<line x1="${ox + 8}" y1="${fmt(wlz)}" x2="${ox + 8 + L * s}" y2="${fmt(wlz)}" stroke="#0ea5e9" stroke-width="0.8" stroke-dasharray="3 3"/>`;
  // plan: x right, y down the page, mirrored about a centerline
  const py0 = oy + H - 40;
  const plan = (
    p: [number, number, number],
    side: 1 | -1,
  ): [number, number] => [ox + 8 + (p[0] - x0) * s, py0 + side * p[1] * s];
  body += path(
    sm.hullSheer.map((h) => plan(h.pos, 1)),
    "#334155",
  );
  body += path(
    sm.hullSheer.map((h) => plan(h.pos, -1)),
    "#334155",
  );
  body += `<line x1="${ox + 8}" y1="${py0}" x2="${ox + 8 + L * s}" y2="${py0}" stroke="#cbd5e1" stroke-width="0.6"/>`;
  // body plan: sections aft of amidships on the left, forward on the right
  const bx = ox + W - 80,
    bz0 = oy + 60;
  body += `<line x1="${bx}" y1="${bz0 - 5}" x2="${bx}" y2="${oy + H - 8}" stroke="#cbd5e1" stroke-width="0.6"/>`;
  for (let k = 1; k <= 9; k++) {
    const u = k / 10;
    let best = -1,
      bd = 1;
    sm.columns.forEach((c, i) => {
      if (!c.pts.length) return;
      const dd = Math.abs(sm.uParams[c.i] - u);
      if (dd < bd) {
        bd = dd;
        best = i;
      }
    });
    if (best < 0) continue;
    const side = u < 0.5 ? -1 : 1;
    body += path(
      sm.columns[best].pts.map((h): [number, number] => [
        bx + side * Math.abs(h.pos[1]) * s,
        bz0 - h.pos[2] * s,
      ]),
      u < 0.5 ? "#7c3aed" : "#2563eb",
      0.8,
    );
  }
  return body;
}

async function writeSheet(name: string, drawn: Drawn[]): Promise<void> {
  const COLS = 3,
    W = 440,
    H = 230;
  const rows = Math.ceil(drawn.length / COLS);
  const svgW = COLS * W,
    svgH = rows * H + 24;
  let body = `<rect width="${svgW}" height="${svgH}" fill="#f8fafc"/><text x="8" y="16" font-family="Helvetica,Arial" font-size="13" fill="#0f172a">${name}</text>`;
  drawn.forEach((d, i) => {
    body += cellSvg(d, (i % COLS) * W, 24 + Math.floor(i / COLS) * H, W, H);
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}">${body}</svg>`;
  const file = join(
    OUT,
    `contact-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
  );
  writeFileSync(`${file}.svg`, svg);
  try {
    const require = createRequire(
      join(process.cwd(), "tools/preview/package.json"),
    );
    const { Resvg } = require("@resvg/resvg-js") as {
      Resvg: new (
        s: string,
        o?: object,
      ) => { render: () => { asPng: () => Uint8Array } };
    };
    writeFileSync(
      `${file}.png`,
      new Resvg(svg, { fitTo: { mode: "width", value: 1600 } })
        .render()
        .asPng(),
    );
  } catch {
    /* no rasterizer here: the SVG is enough */
  }
}

// ---------- run ----------
interface Sampler {
  name: string;
  draw: (rng: () => number) => HullState;
}

const base = defaultHull();
const codec = createHullCodec(base);
const baseModel = assemble(base);

const samplers: Sampler[] = [
  {
    name: "authored jitter σ=0.10",
    draw: (rng) => authoredJitter(base, 0.1, rng),
  },
  {
    name: "authored jitter σ=0.20",
    draw: (rng) => authoredJitter(base, 0.2, rng),
  },
  {
    name: "legacy random.ts adventure=1",
    draw: () => parseHullState(randomDoc(baseModel, 1)),
  },
  ...[0.5, 1, 1.5].map((T) => ({
    name: `reparam prior T=${T}`,
    draw: (rng: () => number) => {
      const th = sampleTheta(codec.dim, rng, T);
      th[0] = 0; // hold the length: a sampler is asked for a shape at the base's size
      return codec.decode(th);
    },
  })),
];
// around a design: the design's own θ plus a small step, with the length and the closure margins held
// (`sampleAround`)
const around = (name: string, hull: HullState, T: number): Sampler => {
  const c = createHullCodec(hull),
    th0 = c.encode(hull);
  return {
    name: `reparam around "${name}" T=${T}`,
    draw: (rng) => c.decode(sampleAround(c, th0, rng, T)),
  };
};
samplers.push(around("default", base, 0.5));

const real: { name: string; hull: HullState }[] = [];
if (DESIGNS) {
  const rows = JSON.parse(readFileSync(DESIGNS, "utf8")) as {
    name: string;
    document: unknown;
  }[];
  for (const r of rows) {
    try {
      const h = parseHullState(JSON.stringify(r.document));
      // a saved design keeps its own waterline; a v1 document without one reads as awash and is given a
      // nominal one so that it can be scored
      real.push({
        name: r.name,
        hull: h.waterline > 0 ? h : { ...h, waterline: 0.15 * loa(h) },
      });
    } catch {
      /* a design this build refuses is not a sample */
    }
  }
  const pick = (
    needle: string,
  ): { name: string; hull: HullState } | undefined =>
    real.find((r) => r.name.includes(needle));
  for (const r of [pick("8.5M REV H"), pick("PRAM")].filter(
    (x): x is { name: string; hull: HullState } => !!x,
  ))
    samplers.push(around(r.name, r.hull, 0.5));
}

const table: { name: string; rates: Record<string, number> }[] = [];
if (real.length) {
  const analyses = real.map((r) => analyze(r.hull));
  table.push({
    name: `real designs (${real.length})`,
    rates: summarize(analyses.map((a) => a.card)),
  });
  await writeSheet(
    "real designs",
    analyses
      .slice(0, 12)
      .map((a, i) => ({ ...a, hull: real[i].hull, label: real[i].name })),
  );
}
for (const s of samplers) {
  const rng = seededRandom(1234);
  const cards: Scorecard[] = [],
    drawn: Drawn[] = [];
  for (let i = 0; i < N; i++) {
    let hull: HullState;
    try {
      hull = s.draw(rng);
    } catch {
      cards.push({ ...analyze(base).card, valid: false, boat: false });
      continue;
    }
    const a = analyze(hull);
    cards.push(a.card);
    if (drawn.length < 12)
      drawn.push({
        ...a,
        hull,
        label: `${a.card.boat ? "boat" : [!a.card.floats && "sinks", !a.card.dry && "wet", !a.card.closed && "open", !a.card.proportioned && "proportions", !a.card.rockerFair && "rocker", !a.card.sectionsFair && "sections"].filter(Boolean).join(", ")}  L/B ${a.card.lb.toFixed(1)} B/T ${a.card.bt.toFixed(1)} Cb ${a.card.cb.toFixed(2)}`,
      });
  }
  table.push({ name: s.name, rates: summarize(cards) });
  await writeSheet(s.name, drawn);
  console.log(`${s.name}: ${(100 * summarize(cards).boat).toFixed(0)}% boats`);
}

const cols = [
  "floats",
  "dry",
  "closed",
  "proportioned",
  "rockerFair",
  "sectionsFair",
  "boat",
];
const spreads = ["spreadLB", "spreadBT", "spreadCb"];
console.log(
  `\n| sampler | ${cols.join(" | ")} | sd ln L/B | sd ln B/T | sd Cb |`,
);
console.log(`|---|${[...cols, ...spreads].map(() => "---:").join("|")}|`);
for (const row of table)
  console.log(
    `| ${row.name} | ${cols.map((c) => `${(100 * row.rates[c]).toFixed(0)}%`).join(" | ")} | ${spreads.map((c) => row.rates[c].toFixed(2)).join(" | ")} |`,
  );
console.log(`\ncontact sheets in ${OUT}/`);

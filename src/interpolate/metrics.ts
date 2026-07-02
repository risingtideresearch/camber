// ---------- the hydrostatic metrics used across the blend explorer ----------
// Every continuous metric the hydrostatics engine produces (lengths/areas/volume in model units — the
// explorer plots relative values, so units don't matter here; the metrics panel carries the dimensioned
// ones). Shared by the pad heatmap (colour by one) and the scatter (plot two against each other).

import type { Hydro } from "../core/hydro";

export interface MetricDef {
  key: string;
  label: string;
  get: (h: Hydro) => number;
}

const amid = (h: Hydro): number => (h.xAft + h.xFwd) / 2;

export const HEAT_METRICS: MetricDef[] = [
  // dimensions
  { key: "lwl", label: "LWL", get: (h) => h.lwl },
  { key: "bwl", label: "Beam · WL", get: (h) => h.bwl },
  { key: "draft", label: "Draft", get: (h) => h.draft },
  // areas & volume
  { key: "vol", label: "∇ · volume", get: (h) => h.vol },
  { key: "waterplane", label: "Waterplane area", get: (h) => h.waterplaneArea },
  { key: "midship", label: "Midship area", get: (h) => h.midshipArea },
  { key: "wetted", label: "Wetted area", get: (h) => h.wettedArea },
  // form coefficients
  { key: "cb", label: "Cb · block", get: (h) => h.cb },
  { key: "cp", label: "Cp · prismatic", get: (h) => h.cp },
  { key: "cm", label: "Cm · midship", get: (h) => h.cm },
  { key: "cw", label: "Cw · waterplane", get: (h) => h.cw },
  { key: "cvp", label: "Cvp · vert. prismatic", get: (h) => h.cvp },
  // centroids & initial stability
  {
    key: "lcb",
    label: "LCB · %",
    get: (h) => ((h.lcb - amid(h)) / h.lwl) * 100,
  },
  {
    key: "lcf",
    label: "LCF · %",
    get: (h) => ((h.lcf - amid(h)) / h.lwl) * 100,
  },
  { key: "kb", label: "KB", get: (h) => h.kb },
  { key: "bmt", label: "BMt", get: (h) => h.bmt },
  { key: "kmt", label: "KMt", get: (h) => h.kmt },
  { key: "bml", label: "BMl", get: (h) => h.bml },
  { key: "kml", label: "KMl", get: (h) => h.kml },
  // ratios & angles
  { key: "loverb", label: "L / B", get: (h) => h.lwl / h.bwl },
  { key: "boverT", label: "B / T", get: (h) => h.bwl / h.draft },
  { key: "slender", label: "L / ∇⅓", get: (h) => h.lwl / Math.cbrt(h.vol) },
  { key: "deadrise", label: "Deadrise", get: (h) => h.deadrise },
  { key: "entrance", label: "½ entrance angle", get: (h) => h.halfEntrance },
];

export const metricByKey = (key: string): MetricDef | undefined =>
  HEAT_METRICS.find((m) => m.key === key);

// sequential colour ramp 0..1 → blue → pale → red (reversed RdYlBu)
export function heatColor(t: number): string {
  const stops = [
    [44, 123, 182],
    [255, 255, 191],
    [215, 25, 28],
  ];
  const u = Math.max(0, Math.min(1, t)) * 2,
    i = u < 1 ? 0 : 1,
    f = u - i,
    a = stops[i],
    b = stops[i + 1];
  const ch = (k: number): number => Math.round(a[k] + (b[k] - a[k]) * f);
  return `rgb(${ch(0)},${ch(1)},${ch(2)})`;
}

// compact numeric formatting for axis ticks / the heat legend
export const fmtMetric = (v: number): string =>
  Math.abs(v) >= 100
    ? v.toFixed(0)
    : Math.abs(v) >= 1
      ? v.toFixed(2)
      : v.toFixed(3);

import type { StabilityData } from "./api";
import type { BookResults } from "../core/sheet/evaluate";

/** Convert all length-derived columns, including PCHIP derivatives (length / volume). */
export function scaleStability(
  data: StabilityData,
  lengthFactor: number,
): StabilityData {
  if (lengthFactor === 1) return data;
  const s = lengthFactor,
    s3 = s ** 3;
  const rows = (values: number[][], factor: number) =>
    values.map((row) => row.map((v) => v * factor));
  const cc = data.curves;
  return {
    curves: {
      ...cc,
      keelZ: cc.keelZ * s,
      vol: rows(cc.vol, s3),
      kn: rows(cc.kn, s),
      wl: rows(cc.wl, s),
      sheerZ: cc.sheerZ.map((v) => v * s),
      knSlope: rows(cc.knSlope, s / s3),
      wlSlope: rows(cc.wlSlope, s / s3),
    },
    limit: data.limit.map((p) => ({ vol: p.vol * s3, kg: p.kg * s })),
    hydro: data.hydro
      ? { vol: data.hydro.vol * s3, kb: data.hydro.kb * s }
      : null,
    lowestSheerKg: data.lowestSheerKg * s,
  };
}

/** The existing sheet link, independent of geometry. Density retains its persisted t/m³ convention. */
export function conditionFromSheet(
  results: BookResults,
  density: number,
  metresPerDisplayUnit: number,
) {
  const mass = results.outputs.displacement;
  if (!mass || !Number.isFinite(mass.v) || mass.v <= 0) return null;
  const vcg = results.outputs.vcg;
  const s = metresPerDisplayUnit;
  return {
    vol: mass.v / 1000 / density / s ** 3,
    kg: vcg && Number.isFinite(vcg.v) ? vcg.v / s : null,
    x: { lo: mass.worst.lo / 1000, hi: mass.worst.hi / 1000 },
    y: vcg ? { lo: vcg.worst.lo / s, hi: vcg.worst.hi / s } : null,
  };
}

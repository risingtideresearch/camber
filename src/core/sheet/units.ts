// ---------- the units a weight sheet is written in ----------
//
// A `Quantity` carries a DIMENSION (mass and length exponents) but no scale: internally the sheet works in
// kilograms and metres and nothing else. A unit string is the crossing between that and what a person types —
// it says both what the number means and what it is written in, so `26` with a unit of `t` is 26000 kg.
//
// Units are declared PER CELL rather than inferred from the formula, and that is deliberate. The alternative
// is unit suffixes inside expressions (`4.2 kg/m2 ± 0.3`), which makes the grammar much larger for something
// a weight schedule already expresses better as a column of its own — every real one has a units column.
//
// What the declaration does depends on what the formula already knows (see `evaluate.ts`):
//
//   • A formula that is DIMENSIONLESS — a bare number, a ratio — is stamped and scaled by the unit. This is
//     the common case: `4.2` in a cell marked `kg/m2` is a plywood areal density.
//
//   • A formula that already carries a dimension — because it touched `HULL.SHELL_AREA` or another row that
//     did — is CHECKED against the unit and warned about on a mismatch, never rescaled and never refused.
//     A weight estimate whose units silently disagree is the bug that makes the answer worthless, but hard
//     inference through free-form formulas would make the tool tiresome, so the pressure is a yellow row.

import {
  addDim,
  DIMLESS,
  scaleDim,
  subDim,
  VOLUME,
  type Dim,
} from "./quantity";

export interface UnitSpec {
  /** What the unit means. */
  readonly dim: Dim;
  /** Base units (kg, m) per one of these. `t` is 1000, `mm` is 0.001. */
  readonly factor: number;
  /** The string as written, for display. */
  readonly label: string;
}

export const DIMLESS_UNIT: UnitSpec = {
  dim: DIMLESS,
  factor: 1,
  label: "",
};

export class UnitError extends Error {}

// The atoms. Everything else is these multiplied, divided and raised to powers.
const ATOMS: Record<string, { dim: Dim; factor: number }> = {
  // mass
  kg: { dim: { m: 1, l: 0 }, factor: 1 },
  kgs: { dim: { m: 1, l: 0 }, factor: 1 },
  g: { dim: { m: 1, l: 0 }, factor: 0.001 },
  t: { dim: { m: 1, l: 0 }, factor: 1000 },
  tonne: { dim: { m: 1, l: 0 }, factor: 1000 },
  lb: { dim: { m: 1, l: 0 }, factor: 0.45359237 },
  lbs: { dim: { m: 1, l: 0 }, factor: 0.45359237 },
  oz: { dim: { m: 1, l: 0 }, factor: 0.028349523125 },
  // volume
  L: { dim: VOLUME, factor: 0.001 },
  litre: { dim: VOLUME, factor: 0.001 },
  liter: { dim: VOLUME, factor: 0.001 },
  // length
  m: { dim: { m: 0, l: 1 }, factor: 1 },
  cm: { dim: { m: 0, l: 1 }, factor: 0.01 },
  mm: { dim: { m: 0, l: 1 }, factor: 0.001 },
  in: { dim: { m: 0, l: 1 }, factor: 0.0254 },
  ft: { dim: { m: 0, l: 1 }, factor: 0.3048 },
};

export const UNIT_ATOMS = Object.keys(ATOMS);

// One factor: a name, optionally raised to a power written as `m2`, `m^2` or `m^-3`.
const FACTOR = /^([A-Za-z]+)(?:\^(-?\d+)|(\d+))?$/;

/**
 * Read a unit string.
 *
 * Accepts `kg`, `m2`, `m^2`, `kg/m2`, `kg*m`, `kg/m^3`, `t`, and an empty string for a plain number. Throws a
 * `UnitError` naming what it could not read — the caller turns that into a per-cell message rather than
 * letting it escape.
 */
export function parseUnit(text: string): UnitSpec {
  const trimmed = text.trim();
  if (!trimmed || trimmed === "—" || trimmed === "-") return DIMLESS_UNIT;

  let dim = DIMLESS;
  let factor = 1;
  // Split on * and / while remembering which one preceded each term, so `kg/m2` divides and `kg*m` multiplies.
  const terms = trimmed.split(/([*/])/);
  let dividing = false;
  for (const raw of terms) {
    const piece = raw.trim();
    if (!piece) continue;
    if (piece === "*") {
      dividing = false;
      continue;
    }
    if (piece === "/") {
      dividing = true;
      continue;
    }
    const match = FACTOR.exec(piece);
    if (!match) throw new UnitError(`"${piece}" is not a unit`);
    const atom = ATOMS[match[1]];
    if (!atom)
      throw new UnitError(
        `"${match[1]}" is not a unit — try one of ${UNIT_ATOMS.join(", ")}`,
      );
    const exp = match[2] ? Number(match[2]) : match[3] ? Number(match[3]) : 1;
    const part = scaleDim(atom.dim, exp);
    const scale = Math.pow(atom.factor, exp);
    if (dividing) {
      dim = subDim(dim, part);
      factor /= scale;
    } else {
      dim = addDim(dim, part);
      factor *= scale;
    }
  }
  return { dim, factor, label: trimmed };
}

/**
 * The unit a dimension is naturally written in: `kg`, `m`, `m2`, `kg/m2`, `kg/m3`.
 *
 * This is what a row shows when it declares nothing, so a formula that acquires a dimension acquires a unit
 * with it and nobody has to type `kg` under a column of masses. Base units only, factor 1 — a suggestion of
 * what the number IS, never a conversion of it.
 */
export function naturalUnit(dim: Dim): UnitSpec {
  const part = (symbol: string, exp: number): string =>
    exp === 0 ? "" : exp === 1 ? symbol : `${symbol}${exp}`;
  const top = [
    dim.m > 0 ? part("kg", dim.m) : "",
    dim.l > 0 ? part("m", dim.l) : "",
  ].filter(Boolean);
  const bottom = [
    dim.m < 0 ? part("kg", -dim.m) : "",
    dim.l < 0 ? part("m", -dim.l) : "",
  ].filter(Boolean);
  const label =
    !top.length && !bottom.length
      ? ""
      : `${top.join("*") || "1"}${bottom.length ? `/${bottom.join("/")}` : ""}`;
  return { dim, factor: 1, label };
}

/** `parseUnit` that answers `null` instead of throwing, for the display paths that only want a label. */
export function tryParseUnit(text: string): UnitSpec | null {
  try {
    return parseUnit(text);
  } catch {
    return null;
  }
}

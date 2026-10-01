import type { LoadingConstraints, LoadingPurpose } from "../core/loading";

export const degrees = (radians: number) => (radians * 180) / Math.PI;
export const radians = (angle: number) => (angle * Math.PI) / 180;

export const showLoadingValue = (
  value: number | null | undefined,
  signed = false,
) =>
  value == null || !Number.isFinite(value)
    ? "—"
    : (Math.abs(value) < 0.0005 ? 0 : value).toLocaleString(undefined, {
        maximumFractionDigits: 3,
        signDisplay: signed ? "exceptZero" : "auto",
      });

export interface LoadingConstraintInputs {
  readonly fixTrim: boolean;
  readonly trim: string;
  readonly fixHeel: boolean;
  readonly heel: string;
}

/** Blank or out-of-range fixed angles must not quietly turn into zero/free. */
export function readLoadingConstraints(
  inputs: LoadingConstraintInputs,
  purpose: LoadingPurpose = "compare-scenarios",
): {
  constraints: LoadingConstraints | null;
  error: string | null;
} {
  const effective =
    purpose === "balance-design"
      ? { ...inputs, fixHeel: true, heel: "0" }
      : inputs;
  for (const [fixed, text, label, limit] of [
    [effective.fixTrim, effective.trim, "Trim", 30],
    [effective.fixHeel, effective.heel, "Heel", 45],
  ] as const) {
    if (
      fixed &&
      (!text.trim() ||
        !Number.isFinite(Number(text)) ||
        Math.abs(Number(text)) > limit)
    )
      return {
        constraints: null,
        error: `${label} must be a finite angle between −${limit}° and ${limit}°.`,
      };
  }
  return {
    constraints: {
      trim: effective.fixTrim ? radians(Number(effective.trim)) : null,
      heel: effective.fixHeel ? radians(Number(effective.heel)) : null,
    },
    error: null,
  };
}

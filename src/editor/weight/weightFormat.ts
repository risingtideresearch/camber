// ---------- putting a number, and a keystroke, where a person can use them ----------
//
// Formatting and the one keyboard gesture that is not a component. Apart from the fields themselves so that
// every view can share them without importing a component it does not render — and so the field module holds
// components and nothing else.

import type { KeyboardEvent } from "react";
import type { Reading } from "../../core/sheet/quantity";

// ---------- formatting ----------

export function sig(v: number): string {
  if (!isFinite(v)) return "—";
  const mag = Math.abs(v);
  if (mag === 0) return "0";
  if (mag >= 1000) return v.toFixed(0);
  if (mag >= 100) return v.toFixed(1);
  if (mag >= 10) return v.toFixed(2);
  if (mag >= 1) return v.toFixed(3);
  return v.toPrecision(3);
}

/** A value in whatever unit the cell is being shown in. */
export const inUnit = (value: number, factor: number): number =>
  factor && factor !== 0 ? value / factor : value;

/**
 * A downward and an upward reach, as a person reads them: one number when the two sides agree, two when they
 * do not.
 *
 * Taken as two loose numbers rather than a `Reading`, because the same shape has to be written for things
 * that are not readings at all — one source's share of a spread, and what a cut's measured area does over the
 * range of its own position.
 */
export function spreadText(lo: number, hi: number, factor: number): string {
  const l = inUnit(lo, factor);
  const h = inUnit(hi, factor);
  if (l === 0 && h === 0) return "";
  if (Math.abs(l - h) < 1e-12 * Math.max(1, Math.abs(h))) return `± ${sig(h)}`;
  return `−${sig(l)} / +${sig(h)}`;
}

/** The ± beside a value, in whichever reading is on screen. */
export const showSpread = (
  reading: Reading,
  factor: number,
  which: "worst" | "likely",
): string => spreadText(reading[which].lo, reading[which].hi, factor);

export const pct = (v: number): string => `${Math.round(v * 100)}%`;

/**
 * A spread as a fraction of the value it sits on — the reading that compares across a schedule, where the
 * absolute one only compares within a column. Null where the nominal is zero, since a percentage of nothing
 * says nothing.
 */
export function relative(lo: number, hi: number, v: number): string | null {
  if (!isFinite(v) || v === 0) return null;
  const half = (lo + hi) / 2 / Math.abs(v);
  return half < 0.001
    ? "<0.1%"
    : `${(half * 100).toFixed(half < 0.1 ? 1 : 0)}%`;
}

/** Alt+↑/↓ moves an item without a mouse — the only way to reorder from the keyboard at all. */
export const nudgeKeys =
  (onNudge: (delta: -1 | 1) => void) =>
  (event: KeyboardEvent): void => {
    if (!event.altKey) return;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      onNudge(-1);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      onNudge(1);
    }
  };

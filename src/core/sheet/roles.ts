// ---------- what an item is, to the rest of the book ----------
//
// One table binding every role to the field kinds that may carry it, a dimension, and a line of
// documentation. It is the third of a set: `hullMetrics.ts` is the only place that knows what a sheet may ask
// the GEOMETRY, `outputs.ts` the only place that knows what the app may ask the BOOK, and this one the only
// place that knows what the book may ask an ITEM.
//
// ---------- why a role and not a naming convention ----------
//
// An item may carry several masses — dry, wet, with ballast — and several positions. Which of them is THE
// mass of the thing is a fact about the item that its field keys cannot state: keying it `mass` forces every
// item to spell it the same way and still cannot tell `dry mass` from `all up mass` on the same item.
//
// A role says it once, on the field, and leaves the key free. `engine.MASS` then survives the engine renaming
// its own field, which is the same promise the rest of the model makes: an address names a thing, never where
// the thing is filed or what it happens to be called this week.
//
// ---------- closed, on purpose ----------
//
// This list is NOT user-extensible, and that is what keeps it from becoming the field schema the rest of the
// design does without. `views.ts` is explicit that columns are not classified — a field key is one item's
// answer, not a declared type — and an open vocabulary of field tags would be exactly that classification
// coming back in through a side door, taking the "refiling breaks nothing" property with it. What is here is
// the app declaring the handful of questions it asks, in the same closed way `OUTPUTS` does.
//
// Adding a role is an entry here and nothing else: no schema change, no stored declaration, no migration.
//
// ---------- at most one per item ----------
//
// A role is functional: an item has one mass. `setFieldRole` enforces that by MOVING the role rather than
// copying it — the sibling that held it gives it up in the same edit — so no sequence of editing can produce
// two. A book arriving from a file can still hold two, and that is reported rather than repaired: see
// `lookupRole` in `book.ts` and the duplicate pass in `views.ts`.

import { LENGTH, MASS, type Dim } from "./quantity";
import type { FieldKind } from "./book";

export interface RoleSpec {
  /** The reserved word a formula writes, and what the file stores. */
  readonly name: string;
  /**
   * The field kinds that may carry it.
   *
   * A cut carries none. A role names a VALUE the item has, and a cut is not one value — it is a position and
   * a handful of measurements read off the hull, so a role on one would have to name a leaf as well. An item
   * whose area is a section's area writes a scalar `= section.area` and tags that instead, which says the
   * same thing and keeps the role's referent unambiguous.
   */
  readonly kinds: readonly FieldKind[];
  /** What it has to work out to. A field that disagrees is warned about, never refused. */
  readonly dim: Dim;
  /** How the chip and the tooltips name it, in prose. */
  readonly label: string;
  readonly hint: string;
}

/** The catalogue: what the item weighs, then where that weight acts. */
export const ROLES: readonly RoleSpec[] = [
  {
    name: "MASS",
    kinds: ["scalar"],
    dim: MASS,
    label: "mass",
    hint: "What this item weighs, whichever of its fields says so",
  },
  {
    name: "CG",
    kinds: ["point"],
    dim: LENGTH,
    label: "centre of gravity",
    hint: "Where this item's weight acts, whichever of its positions says so",
  },
];

const BY_NAME = new Map(ROLES.map((spec) => [spec.name, spec]));

/** The reserved words the roles take, for `RESERVED` and for the lexer's symbol table. */
export const ROLE_NAMES: readonly string[] = ROLES.map((spec) => spec.name);

export const roleSpec = (name: string): RoleSpec | undefined =>
  BY_NAME.get(name);

export const isRoleName = (name: string): boolean => BY_NAME.has(name);

/** The roles a field of this kind may be given, which is what the detail card offers as chips. */
export const rolesForKind = (kind: FieldKind): RoleSpec[] =>
  ROLES.filter((spec) => spec.kinds.includes(kind));

export const canCarryRole = (kind: FieldKind, name: string): boolean =>
  BY_NAME.get(name)?.kinds.includes(kind) ?? false;

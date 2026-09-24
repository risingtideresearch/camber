import { findItem, leavesOf, type WeightBook } from "../../core/sheet/book";
import { cellKey } from "../../core/sheet/evaluate";
import { GEOMETRY_LEAVES } from "../../core/sheet/sectionMeasures";

/** The same authored and measured rows shown by the spread inspector. */
export function sampledFieldKeys(
  book: WeightBook,
  itemId: string,
  fieldKey: string,
): readonly string[] {
  const field = findItem(book, itemId)?.fields[fieldKey];
  if (!field) return [];
  const leaves = [
    ...leavesOf(field),
    ...(field.k === "repetition" ? ["equivalentCount"] : []),
    ...(field.k === "cut" || field.k === "repetition" ? GEOMETRY_LEAVES : []),
  ];
  return leaves.map((leaf) => cellKey(itemId, fieldKey, leaf));
}

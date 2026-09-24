/** Pseudo item for authored book outputs; real item ids are i-prefixed. */
export const OUTPUT_ITEM = "OUT";

/** Stable cell address within a book revision; scalar leaves default to formula. */
export const cellKey = (
  itemId: string,
  fieldKey: string,
  leaf = "formula",
): string => `${itemId} ${fieldKey} ${leaf}`;

// ---------- model-change notification ----------
//
// A single optional listener invoked after every model-mutating render. The standalone app leaves it
// unset; the Patchwork tool sets it to persist the edited hull back into its Automerge document. Kept in
// its own module so `render.ts` can notify without importing the embedding layer (avoids a cycle).

let listener: (() => void) | null = null;

export function setModelChangeListener(fn: (() => void) | null): void {
  listener = fn;
}

export function notifyModelChange(): void {
  if (listener) listener();
}

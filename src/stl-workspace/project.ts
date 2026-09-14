// Portable, uncompressed local project: magic + LE manifest length + UTF-8 JSON + original STL.
// No paths, remote assets or cached answers. Reopen parses; numerical validation is on demand.
import { EMPTY_LOADING, type StabilityLoadingState } from "../analysis/loading";
import { buildSheetJson, parseSheet } from "../core/sheet/json";
import type { WeightBook } from "../core/sheet/book";
import {
  validateConfiguration,
  configurationForEnvelope,
  type Asset,
  type Configuration,
} from "./setup";
const MAGIC = new TextEncoder().encode("CAMBER-STL-1\n");
const MAX_META = 4 * 1024 * 1024;
export function hasProjectMagic(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < MAGIC.length) return false;
  const view = new Uint8Array(bytes, 0, MAGIC.length);
  return MAGIC.every((value, index) => view[index] === value);
}
export const MAX_PROJECT_BYTES = 64 * 1024 * 1024 + MAX_META + 16;
export function encodeProject(
  asset: Asset,
  configuration: Configuration,
  book: WeightBook,
  loading: StabilityLoadingState = EMPTY_LOADING,
): Blob {
  validateConfiguration(configuration);
  validateLoading(loading);
  const meta = new TextEncoder().encode(
    JSON.stringify({
      version: 3,
      loading,
      name: asset.name,
      configuration,
      book: JSON.parse(buildSheetJson(book)),
      assetBytes: asset.bytes.byteLength,
    }),
  );
  if (meta.length > MAX_META)
    throw new Error("Project manifest exceeds 4 MiB.");
  const header = new Uint8Array(MAGIC.length + 4);
  header.set(MAGIC);
  new DataView(header.buffer).setUint32(MAGIC.length, meta.length, true);
  return new Blob([header, meta, asset.bytes], {
    type: "application/octet-stream",
  });
}
export function decodeProject(bytes: ArrayBuffer): {
  asset: Asset;
  configuration: Configuration;
  book: WeightBook;
  loading: StabilityLoadingState;
  migration?: string;
} {
  if (
    bytes.byteLength > MAX_PROJECT_BYTES ||
    bytes.byteLength < MAGIC.length + 4 ||
    !hasProjectMagic(bytes)
  )
    throw new Error("Not a supported Camber STL analysis project.");
  const size = new DataView(bytes).getUint32(MAGIC.length, true),
    start = MAGIC.length + 4;
  if (size > MAX_META || start + size > bytes.byteLength)
    throw new Error("Truncated or oversized project manifest.");
  const m = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      new Uint8Array(bytes, start, size),
    ),
  );
  if (
    ![1, 2, 3].includes(m?.version) ||
    (m.version === 1 && m.configuration?.repair !== undefined) ||
    typeof m.name !== "string" ||
    m.name.length > 1024 ||
    !m.configuration ||
    typeof m.configuration.closeDeck !== "boolean" ||
    typeof m.configuration.wholeSurface !== "boolean" ||
    ![1, 2].includes(m.book?.version) ||
    !Array.isArray(m.book.items) ||
    !Array.isArray(m.book.views) ||
    !Number.isFinite(m.book.density) ||
    m.book.density <= 0
  )
    throw new Error("Invalid or unsupported project metadata / weight book.");
  const migration = m.configuration.closeDeck
    ? "Legacy deck closure removed: open-sheer analysis stops at first rim immersion. Download an updated project snapshot."
    : m.version < 3
      ? "Project upgraded to progressive setup. Download an updated project snapshot."
      : undefined;
  m.configuration = configurationForEnvelope(m.configuration);
  // Older projects had already reviewed their coordinate convention.
  if (m.version < 3) m.configuration.frameConfirmed = true;
  validateConfiguration(m.configuration);
  const loading = m.version === 3 ? m.loading : { ...EMPTY_LOADING };
  validateLoading(loading);
  const asset = bytes.slice(start + size);
  if (asset.byteLength > 64 * 1024 * 1024 || m.assetBytes !== asset.byteLength)
    throw new Error("Missing, oversized or truncated STL asset.");
  return {
    asset: { name: m.name, bytes: asset },
    configuration: m.configuration,
    loading,
    migration,
    book: parseSheet(JSON.stringify(m.book)),
  };
}
export function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function validateLoading(value: StabilityLoadingState): void {
  if (
    !value ||
    typeof value.linkSheet !== "boolean" ||
    (value.condition !== null &&
      (!value.condition ||
        !Number.isFinite(value.condition.vol) ||
        value.condition.vol < 0 ||
        !Number.isFinite(value.condition.kg)))
  )
    throw new Error("Invalid loading condition");
  if (value.spread !== null)
    for (const axis of ["x", "y"] as const) {
      const a = value.spread?.[axis];
      if (
        !a ||
        typeof a.on !== "boolean" ||
        typeof a.linked !== "boolean" ||
        !Number.isFinite(a.lo) ||
        a.lo < 0 ||
        !Number.isFinite(a.hi) ||
        a.hi < 0
      )
        throw new Error("Invalid loading uncertainty");
    }
}

// Optional local recovery, not a saved/downloaded file. Store asset bytes once
// per project; debounce small authored snapshots without copying the STL again.
import { buildSheetJson, parseSheet } from "../core/sheet/json";
import { validateConfiguration, type Asset } from "./setup";
import { validateLoading } from "./project";
import type { ProjectSnapshot } from "./session";

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("camber-stl-recovery", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("recovery");
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("Recovery storage is blocked by another window"));
    request.onsuccess = () => resolve(request.result);
  });
}
function complete(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () =>
      reject(tx.error ?? new Error("Recovery storage failed"));
  });
}
let queue: Promise<unknown> = Promise.resolve();
export function writeRecovery(
  id: string,
  asset: Asset,
  document: ProjectSnapshot,
): Promise<void> {
  const job = async () => {
    const book = buildSheetJson(document.book);
    const metadata = {
      version: 1,
      id,
      configuration: document.configuration,
      loading: document.loading,
      book,
    };
    if (
      new TextEncoder().encode(JSON.stringify(metadata)).byteLength >
      4 * 1024 * 1024
    )
      throw new Error(
        "Recovery metadata exceeds 4 MiB; download the project instead",
      );
    const db = await database();
    try {
      const tx = db.transaction("recovery", "readwrite"),
        done = complete(tx);
      const store = tx.objectStore("recovery"),
        previous = store.get("asset-id");
      previous.onsuccess = () => {
        if (previous.result !== id) {
          store.put({ id, asset }, "asset");
          store.put(id, "asset-id");
        }
        store.put(metadata, "document");
      };
      await done;
    } finally {
      db.close();
    }
  };
  const next = queue.then(job, job);
  queue = next.catch(() => undefined);
  return next;
}
export async function readRecovery(): Promise<{
  asset: Asset;
  document: ProjectSnapshot;
} | null> {
  await queue;
  const db = await database();
  try {
    const tx = db.transaction("recovery", "readonly"),
      done = complete(tx);
    const a = tx.objectStore("recovery").get("asset"),
      d = tx.objectStore("recovery").get("document");
    await done;
    const source = a.result,
      saved = d.result;
    if (!source && !saved) return null;
    if (
      !source ||
      !saved ||
      saved.version !== 1 ||
      source.id !== saved.id ||
      typeof source.asset?.name !== "string" ||
      !(source.asset.bytes instanceof ArrayBuffer) ||
      source.asset.bytes.byteLength > 64 * 1024 * 1024 ||
      typeof saved.book !== "string" ||
      saved.book.length > 4 * 1024 * 1024
    )
      throw new Error("Invalid local recovery snapshot");
    validateConfiguration(saved.configuration);
    validateLoading(saved.loading);
    const book = JSON.parse(saved.book);
    if (
      ![1, 2].includes(book?.version) ||
      !Array.isArray(book.items) ||
      !Array.isArray(book.views)
    )
      throw new Error("Invalid recovery weight book");
    return {
      asset: source.asset,
      document: {
        configuration: saved.configuration,
        loading: saved.loading,
        book: parseSheet(saved.book),
      },
    };
  } finally {
    db.close();
  }
}
export function clearRecovery(): Promise<void> {
  const job = async () => {
    const db = await database();
    try {
      const tx = db.transaction("recovery", "readwrite"),
        done = complete(tx);
      tx.objectStore("recovery").clear();
      await done;
    } finally {
      db.close();
    }
  };
  const next = queue.then(job, job);
  queue = next.catch(() => undefined);
  return next;
}

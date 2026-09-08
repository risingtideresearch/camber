import { parseStl } from "../../core/stlImport";
import { closeDeck } from "./closure";
import { prepareMesh } from "./prepare";
import type { MeshImport } from "./protocol";
export function importAnalysisStl(buffer: ArrayBuffer, setup: MeshImport) {
  const raw = parseStl(buffer);
  const mesh = prepareMesh(raw.positions, setup.physical, {
    allowOpen: !!setup.deckClosure,
  });
  return mesh.report.closed ? mesh : closeDeck(mesh, setup.deckClosure!);
}

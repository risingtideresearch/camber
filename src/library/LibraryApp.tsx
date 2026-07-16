import { useCallback, useEffect, useMemo, useState } from "react";
import { createModel, resetModel } from "../core/model";
import {
  deleteDesign,
  insertDesign,
  listDesigns,
  type DesignRow,
} from "../core/supabase";
import { isReadableVersion } from "../core/document";
import { loadJsonText, parseDocument } from "../core/json";
import { buildStep } from "../core/step";
import { buildStl } from "../core/stl";
import { buildPreviewSvg } from "../core/preview";
import { buildZip, type ZipEntry } from "../core/zip";
import { Button } from "../components/Button";
import { TopBar } from "../components/TopBar";
import { DesignCard } from "./DesignCard";
import { topoOf, type Topo } from "./topo";
import "./LibraryApp.css";

// The design library (the fullscreen file view). Lists the hull designs stored in Supabase and lets you open
// one in the editor, start a new one, import a JSON file, blend a compatible family in the interpolation
// viewer, or export the selected design as JSON / STEP / STL. Exports reuse the same code paths as the editor:
// JSON is the stored document verbatim; STEP and STL load the document into a model and run their writers
// (which fair the surfaces internally). It owns one scratch model shared by the topology and export paths.

const msg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

function download(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function downloadBlob(filename: string, text: string, mime: string): void {
  download(filename, new Blob([text], { type: mime }));
}

// a filesystem-safe version of a design name for download filenames
function safeName(name: string): string {
  return name.replace(/[^\w.\- ]+/g, "_").trim() || "hull";
}

export function LibraryApp() {
  // one scratch model, shared by the topology reads (during render) and the export paths (on click); every
  // consumer either only reads counts or resets it first, so a single instance is safe.
  const [model] = useState(() => createModel());

  const [rows, setRows] = useState<DesignRow[]>([]);
  const [loaded, setLoaded] = useState(false); // first list load has resolved (governs the empty / error text)
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // blend mode: null when off; otherwise the base hull's length — peers must share it (the interpolator
  // reconciles differing control-point counts on open, so a shared length is the only hard requirement).
  const [blend, setBlend] = useState<{ baseLength: number } | null>(null);
  const [blendSel, setBlendSel] = useState<Set<string>>(() => new Set());
  const blendMode = blend !== null;

  // every design's topology (stat chips + blend compatibility), recomputed when the list changes
  const topoById = useMemo(() => {
    const m = new Map<string, Topo | null>();
    for (const row of rows) m.set(row.id, topoOf(row));
    return m;
  }, [rows]);

  const selectedRow = rows.find((r) => r.id === selectedId);

  const isCompatible = useCallback(
    (id: string): boolean => {
      if (!blend) return false;
      const t = topoById.get(id);
      return !!t && t.length === blend.baseLength;
    },
    [blend, topoById],
  );

  // ---------- loading ----------
  const refresh = useCallback(async () => {
    try {
      // Drop documents a newer build wrote (version > VERSION) before they reach `rows`: this app cannot read
      // them, so it cannot list, open, blend or export them either — every path below works off `rows`.
      const next = (await listDesigns()).filter((r) =>
        isReadableVersion(r.document),
      );
      setRows(next);
      setError(null);
      setSelectedId((cur) =>
        cur && next.some((r) => r.id === cur) ? cur : null,
      );
    } catch (e) {
      setRows([]);
      setError("Failed to load designs: " + msg(e));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await refresh();
    })();
  }, [refresh]);

  // ---------- selection / blend interactions ----------
  const onCardClick = (id: string) => {
    if (blend) {
      if (!isCompatible(id)) return; // incompatible cards are inert
      setBlendSel((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else if (next.size < 5) next.add(id);
        return next;
      });
    } else {
      setSelectedId(id);
    }
  };

  const enterBlend = () => {
    const t = selectedRow ? topoById.get(selectedRow.id) : null;
    if (!selectedRow || !t) return;
    setBlend({ baseLength: t.length });
    setBlendSel(new Set([selectedRow.id]));
  };
  const exitBlend = () => {
    setBlend(null);
    setBlendSel(new Set());
  };
  const openBlender = () => {
    // preserve grid (newest-first) order
    const ids = rows.filter((r) => blendSel.has(r.id)).map((r) => r.id);
    if (ids.length < 2) return;
    window.location.href = `interpolate.html?ids=${ids.join(",")}`;
  };

  // Blend needs the selected design plus at least one same-length peer (counts are reconciled on open).
  const selTopo = selectedRow ? topoById.get(selectedRow.id) : null;
  const blendPeers = selTopo
    ? rows.filter((r) => topoById.get(r.id)?.length === selTopo.length).length
    : 0;
  const compatCount = blend ? rows.filter((r) => isCompatible(r.id)).length : 0;

  // ---------- navigation ----------
  const newDesign = () => {
    window.location.href = "editor.html";
  };
  const openInEditor = (id: string) => {
    window.location.href = `editor.html?id=${encodeURIComponent(id)}`;
  };

  // ---------- exports (reuse the editor's writers via the scratch model) ----------
  const exportJson = () => {
    if (!selectedRow) return;
    try {
      // pretty-print the stored document on the way out
      downloadBlob(
        `${safeName(selectedRow.name)}.json`,
        JSON.stringify(selectedRow.document, null, 2),
        "application/json",
      );
    } catch (e) {
      alert("Export JSON failed: " + msg(e));
    }
  };
  // bundle every design's document (already in `rows`) into one ZIP of pretty-printed JSON files
  const exportAllJson = () => {
    if (rows.length === 0) return;
    try {
      const encoder = new TextEncoder();
      const used = new Set<string>(); // dedupe filenames — two designs may share a name
      const entries: ZipEntry[] = rows.map((row) => {
        const base = safeName(row.name);
        let name = `${base}.json`;
        for (let i = 2; used.has(name); i++) name = `${base} (${i}).json`;
        used.add(name);
        return {
          name,
          data: encoder.encode(JSON.stringify(row.document, null, 2)),
        };
      });
      const stamp = new Date().toISOString().slice(0, 10);
      download(`camber-designs-${stamp}.zip`, buildZip(entries));
    } catch (e) {
      alert("Export All JSON failed: " + msg(e));
    }
  };
  const exportStep = () => {
    if (!selectedRow) return;
    try {
      resetModel(model);
      loadJsonText(model, JSON.stringify(selectedRow.document)); // buildStep fairs + samples it
      const stamp = new Date().toISOString().replace(/\.\d+Z$/, "");
      downloadBlob(
        `${safeName(selectedRow.name)}.step`,
        buildStep(model, stamp),
        "application/step",
      );
    } catch (e) {
      alert("Export STEP failed: " + msg(e));
    }
  };
  const exportStl = () => {
    if (!selectedRow) return;
    try {
      resetModel(model);
      loadJsonText(model, JSON.stringify(selectedRow.document)); // buildStl fairs + meshes it
      downloadBlob(
        `${safeName(selectedRow.name)}.stl`,
        buildStl(model, safeName(selectedRow.name)),
        "model/stl",
      );
    } catch (e) {
      alert("Export STL failed: " + msg(e));
    }
  };

  // ---------- delete ----------
  const onDelete = async () => {
    if (!selectedRow) return;
    if (!confirm(`Delete "${selectedRow.name}"? This cannot be undone.`))
      return;
    setDeleting(true);
    try {
      await deleteDesign(selectedRow.id);
      setSelectedId(null);
      await refresh();
    } catch (e) {
      alert("Delete failed: " + msg(e));
    } finally {
      setDeleting(false);
    }
  };

  // ---------- import ----------
  const importJson = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      let text: string;
      try {
        text = await file.text();
        parseDocument(text); // validate before storing; throws on a malformed document
      } catch (e) {
        alert("Import failed: " + msg(e));
        return;
      }
      const base = file.name.replace(/\.json$/i, "");
      const name = (prompt("Save imported design as:", base) ?? "").trim();
      if (!name) return;
      // build the wireframe preview from the imported document (same path the editor uses on save)
      let preview = "";
      try {
        resetModel(model);
        loadJsonText(model, text);
        preview = buildPreviewSvg(model);
      } catch {
        /* leave preview empty; the card falls back to a placeholder */
      }
      try {
        const id = await insertDesign(name, text, preview);
        setSelectedId(id);
        await refresh();
      } catch (e) {
        alert("Import failed: " + msg(e));
      }
    });
    input.click();
  };

  return (
    <div className={"fileapp" + (blendMode ? " blending" : "")}>
      <TopBar>
        <div className="brand">
          Camber <span>design library</span>
        </div>
        <span className="spacer" />
        <Button
          variant="primary"
          title="Start a new hull in the editor"
          onClick={newDesign}
        >
          + New design
        </Button>
        <Button
          title="Add a hull design from a JSON file to the library"
          onClick={importJson}
        >
          Import JSON…
        </Button>
        <Button
          disabled={rows.length === 0}
          title="Download every design in the library as a ZIP of JSON files"
          onClick={exportAllJson}
        >
          Export All JSON
        </Button>
      </TopBar>

      {!blendMode ? (
        <TopBar className="seltoolbar">
          <span className={"selname" + (selectedRow ? "" : " none")}>
            {selectedRow ? selectedRow.name : "No design selected"}
          </span>
          <span className="spacer" />
          <Button
            disabled={blendPeers < 2}
            title="Pick compatible hulls and open them in the interpolation blender"
            onClick={enterBlend}
          >
            Blend…
          </Button>
          <Button
            disabled={!selectedRow}
            title="Open the selected design in the editor"
            onClick={() => selectedRow && openInEditor(selectedRow.id)}
          >
            Open
          </Button>
          <Button
            disabled={!selectedRow}
            title="Download the selected design as JSON"
            onClick={exportJson}
          >
            Export JSON
          </Button>
          <Button
            disabled={!selectedRow}
            title="Export the selected design as a STEP (ISO 10303) file"
            onClick={exportStep}
          >
            Export STEP
          </Button>
          <Button
            disabled={!selectedRow}
            title="Export the selected design as an STL triangle mesh"
            onClick={exportStl}
          >
            Export STL
          </Button>
          <Button
            variant="danger"
            disabled={!selectedRow || deleting}
            title="Delete the selected design"
            onClick={onDelete}
          >
            Delete
          </Button>
        </TopBar>
      ) : (
        <TopBar className="seltoolbar">
          <span className="selname">
            {`${blendSel.size} selected · pick 2–5 of ${compatCount} blendable hulls`}
          </span>
          <span className="spacer" />
          <Button
            variant="primary"
            disabled={blendSel.size < 2 || blendSel.size > 5}
            title="Open the selected hulls in the interpolation blender"
            onClick={openBlender}
          >
            Open blender
          </Button>
          <Button title="Cancel blend selection" onClick={exitBlend}>
            Cancel
          </Button>
        </TopBar>
      )}

      <div className="gridwrap">
        {rows.length > 0 && (
          <div className="grid">
            {rows.map((row) => (
              <DesignCard
                key={row.id}
                row={row}
                topo={topoById.get(row.id) ?? null}
                selected={!blendMode && row.id === selectedId}
                compat={blendMode && isCompatible(row.id)}
                incompat={blendMode && !isCompatible(row.id)}
                picked={blendMode && blendSel.has(row.id)}
                onClick={() => onCardClick(row.id)}
                onDoubleClick={() => {
                  if (!blendMode) openInEditor(row.id);
                }}
              />
            ))}
          </div>
        )}
        {loaded && error && <div className="empty err">{error}</div>}
        {loaded && !error && rows.length === 0 && (
          <div className="empty">
            No designs yet. Create one with “+ New design”, or import a JSON
            file.
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- editor bootstrap: wire the app-level controls and render ----------
//
// This is the standalone editor's startup, factored out of `main.ts` so it can be reused. The page entry
// (`main.ts`) calls `startEditor()` with no options; the Patchwork tool injects the editor scaffold into
// its own container and calls `startEditor({ styleRoot, initialJson, onChange })` to bind the editor to an
// Automerge document. The editor still works against the module-level `state` singleton, so only one
// instance can be live on a page at a time.

import { resetModel, state } from "./model.js";
import { render, draw3d } from "./render.js";
import { initInteraction, refreshSelUI, addBlendPoint } from "./interaction.js";
import { downloadStep } from "./step.js";
import { downloadJson, importJson, buildJson, loadJsonText } from "./json.js";
import { svgL, svgP, svgW, initDom } from "./dom.js";
import { LH, PH, WVW, WVH } from "./view.js";
import { setModelChangeListener } from "./hooks.js";

export interface EditorOptions {
  // Element the CSS palette is read from (defaults to the document root). The Patchwork tool passes its
  // own scoped container so the editor's variables don't have to live on `:root`.
  styleRoot?: Element;
  // A `HullDocument` JSON string to load on startup instead of the built-in default.
  initialJson?: string;
  // Invoked after every model-mutating render with the current model serialized as a `HullDocument`.
  // The embedding tool uses this to persist edits; never fired while `loadJson()` is applying.
  onChange?: (json: string) => void;
}

export interface CamberEditor {
  // The current model serialized as a single-variant `HullDocument`.
  getJson(): string;
  // Replace the model with the given `HullDocument` JSON (clears the selection). Does not fire `onChange`.
  loadJson(text: string): void;
  // Apply an incoming remote change: like `loadJson`, but keeps the current selection if it still resolves
  // and tolerates a transiently inconsistent document (returns false instead of throwing). Does not fire
  // `onChange`.
  applyRemote(text: string): boolean;
  // Remove window-level listeners and stop persisting. The caller is responsible for removing the
  // injected scaffold from the DOM.
  destroy(): void;
}

export function startEditor(opts: EditorOptions = {}): CamberEditor {
  initDom(opts.styleRoot);

  // the plan / profile strips are sized to the isometric scale (see view.ts); set their viewBox heights
  // from the derived constants so the SVG aspect matches the to-scale drawing (no stretching). The blend
  // control carries its own (vertical) viewBox.
  svgL.setAttribute("viewBox", `0 0 1000 ${LH}`);
  svgP.setAttribute("viewBox", `0 0 1000 ${PH}`);
  svgW.setAttribute("viewBox", `0 0 ${WVW} ${WVH}`);

  // ---------- size the right column ----------
  // The right column's width IS the section editor's side: the square fills that width (CSS aspect-ratio),
  // and the blend control takes the remaining height below it.
  const MIN_SIDE = 220,
    MAX_SIDE = 460,
    LEFT_GAP = 20; // the two 10px gaps between the three stacked items in the left column
  const mainEl = document.querySelector(".main") as HTMLElement;
  const rightCol = document.querySelector(".rightcol") as HTMLElement;
  const leftCol = document.querySelector(".leftcol") as HTMLElement;

  function fitLayout(): void {
    const w = mainEl.clientWidth,
      h = mainEl.clientHeight;
    if (!w || !h) return;
    const side = Math.max(MIN_SIDE, Math.min(MAX_SIDE, Math.min(w * 0.34, h * 0.5)));
    rightCol.style.width = `${side}px`;
    const stripAspect = (LH + PH) / 1000;
    const leftMax = Math.max(360, (h - side - LEFT_GAP) / stripAspect);
    leftCol.style.maxWidth = `${leftMax}px`;
  }

  // the 3D canvas fills a flex box, so reflow it on resize (mesh is cached; just redraw)
  const onResize = (): void => {
    fitLayout();
    draw3d(false);
  };
  window.addEventListener("resize", onResize);

  function reset(): void {
    resetModel();
    state.selected = null; // the old selection no longer refers to a meaningful point
    render(); // render() runs prepare() to build the sheer samplers before drawing
    refreshSelUI();
    syncTrim();
  }

  // ---------- waterline + deck-rake controls ----------
  const wlRange = document.getElementById("wlRange") as HTMLInputElement;
  const wlVal = document.getElementById("wlVal") as HTMLElement;
  const rakeRange = document.getElementById("rakeRange") as HTMLInputElement;
  const rakeVal = document.getElementById("rakeVal") as HTMLElement;

  function syncTrim(): void {
    wlRange.value = String(state.waterline);
    wlVal.textContent = String(Math.round(state.waterline));
    const deg = (state.deckRake * 180) / Math.PI;
    rakeRange.value = String(deg);
    rakeVal.textContent = `${deg.toFixed(1)}°`;
  }
  wlRange.addEventListener("input", () => {
    state.waterline = parseFloat(wlRange.value);
    wlVal.textContent = String(Math.round(state.waterline));
    render();
  });
  rakeRange.addEventListener("input", () => {
    const deg = parseFloat(rakeRange.value);
    state.deckRake = (deg * Math.PI) / 180;
    rakeVal.textContent = `${deg.toFixed(1)}°`;
    render();
  });

  const toggle3d = document.getElementById("toggle3d") as HTMLButtonElement;
  toggle3d.addEventListener("click", () => {
    state.view3d = state.view3d === "trimmed" ? "sheet" : "trimmed";
    toggle3d.textContent = state.view3d === "trimmed" ? "Untrimmed sheet" : "Trimmed hull";
    draw3d(true);
  });

  const toggleZebra = document.getElementById("toggleZebra") as HTMLButtonElement;
  toggleZebra.addEventListener("click", () => {
    state.zebra = !state.zebra;
    toggleZebra.classList.toggle("on", state.zebra);
    draw3d(false);
  });

  document.getElementById("addBlendBtn")!.addEventListener("click", () => addBlendPoint());

  document.getElementById("reset")!.addEventListener("click", reset);

  const exportStep = document.getElementById("exportStep") as HTMLButtonElement;
  exportStep.addEventListener("click", () => {
    try {
      downloadStep();
    } catch (e) {
      alert("STEP export failed: " + (e instanceof Error ? e.message : String(e)));
    }
  });

  const exportJson = document.getElementById("exportJson") as HTMLButtonElement;
  exportJson.addEventListener("click", () => {
    try {
      downloadJson();
    } catch (e) {
      alert("JSON export failed: " + (e instanceof Error ? e.message : String(e)));
    }
  });

  const importJsonBtn = document.getElementById("importJson") as HTMLButtonElement;
  importJsonBtn.addEventListener("click", () =>
    importJson(() => {
      render(); // loadHull already cleared the selection
      refreshSelUI();
      syncTrim(); // waterline / deck rake may have come from the file
    }),
  );

  const teardownInteraction = initInteraction();
  fitLayout(); // size the columns before the first render so the 3D canvas picks up its real size

  // `loadJson` re-renders, which would otherwise fire `onChange`; this flag suppresses that echo so an
  // incoming remote change is not immediately written straight back out.
  let applying = false;

  // Keep the current selection only if it still points at an existing control point after a load (a
  // remote edit may have added/removed points). Returns null if it no longer resolves.
  function validatedSelection(): typeof state.selected {
    const s = state.selected;
    if (!s) return null;
    if (s.tgt === "plan") return s.idx < state.sheer.cp.length ? s : null;
    if (s.tgt === "trim") return s.idx < state.sheer.trim.length ? s : null;
    if (s.tgt === "transom") return s.idx < state.sheer.transom.length ? s : null;
    if (s.tgt === "weight") return s.idx < state.weights.length ? s : null;
    // template
    const ti = s.ti ?? 0;
    return ti < state.templates.length && s.idx < state.templates[ti].length ? s : null;
  }

  function applyLoad(text: string, preserveSelection: boolean): void {
    applying = true;
    try {
      const prev = state.selected;
      loadJsonText(text); // clears the selection internally (loadHull)
      state.selected = preserveSelection ? prev : null;
      state.selected = validatedSelection(); // drop it if the load changed the topology out from under it
      render();
      refreshSelUI();
      syncTrim(); // waterline / deck rake may have come from the document
    } finally {
      applying = false;
    }
  }

  // Initial content: the document's hull if embedded, otherwise the built-in default.
  if (opts.initialJson !== undefined) applyLoad(opts.initialJson, false);
  else reset();

  // Register the persistence hook only after the initial load, so loading the starting hull does not
  // count as an edit.
  if (opts.onChange) {
    const cb = opts.onChange;
    setModelChangeListener(() => {
      if (!applying) cb(buildJson());
    });
  }

  return {
    getJson: () => buildJson(),
    loadJson: (text: string) => applyLoad(text, false),
    applyRemote: (text: string) => {
      try {
        applyLoad(text, true);
        return true;
      } catch {
        // A document mid-merge can be transiently inconsistent (e.g. a topology count not yet matching a
        // variant's point count); skip this revision and wait for the next consistent one.
        return false;
      }
    },
    destroy: () => {
      setModelChangeListener(null);
      window.removeEventListener("resize", onResize);
      teardownInteraction();
    },
  };
}

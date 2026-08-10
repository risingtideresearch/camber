import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Model } from "../core/model";
import { assemble } from "../core/runtime";
import { defaultHull } from "../core/hull";
import { hydrostatics, type Hydro } from "../core/hydro";
import { parseDocument, type ParsedDoc } from "../core/json";
import { promoteFamily } from "../core/promote";
import { getDesign } from "../core/supabase";
import { View3d } from "../components/View3d";
import { Button } from "../components/Button";
import { FilenameInput } from "../components/FilenameInput";
import {
  blendState,
  computeSamples,
  weightsFromControl,
  PADC,
  type Hull,
  type Pt,
  type Sample,
} from "./blend";
import {
  isDirty,
  newBlendId,
  saveBlend,
  saveView,
  type BlendId,
  type SaveView,
} from "./save";
import { BlendControl } from "./BlendControl";
import { BlendExplorer } from "./BlendExplorer";
import { MetricsPanel, type Unit, type Water } from "./MetricsPanel";
import "./InterpolateApp.css";

// The interpolation viewer. It loads 2–5 exported hulls, forms a convex blend of
// them per the data model's interpolation rule, writes that blend into a single shared model, and drives the
// shared 3D view + live hydrostatics from it. It owns a stable, mutable model
// whose reactivity is driven by the blend-control state (the slider param / pad puck) and the loaded family.

const INITIAL_SAVE: SaveView = { buttonLabel: "Save As…", kind: "", text: "" };
const msg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);
// stable empty sentinel — identity is compared against samplesState.forHulls to derive `sampling`
const NO_SAMPLES: Sample[] = [];

// Add a parsed document's hull to the family. Collects any problem into `errs`; mutates `hulls`.
//
// There is nothing left to check but the family's size: v1 required every hull to share one `length` (its
// coordinates were unitless against it), while v2's are absolute in a real unit — promoteFamily converts the
// family into the first hull's unit and reconciles the control-point counts and the station correspondence,
// and hulls of different lengths simply blend to an intermediate length.
function addParsedDoc(
  parsed: ParsedDoc,
  base: string,
  hulls: Hull[],
  errs: string[],
): void {
  if (hulls.length >= 5) {
    errs.push(`${base}: family is full (max 5 hulls) — hull skipped`);
    return;
  }
  hulls.push({ name: parsed.hull.name ?? base, data: parsed.hull });
}

export function InterpolateApp() {
  // the loaded family + whether the last load needed topology promotion (surfaced in the status line)
  const [hulls, setHulls] = useState<Hull[]>([]);
  const [promoted, setPromoted] = useState(false);
  // the blend control: the source of truth for the weights (a slider param for 2, a pad puck for 3+)
  const [tTwo, setTTwo] = useState(0.5);
  const [puck, setPuck] = useState<Pt>({ x: PADC, y: PADC });
  const n = hulls.length;

  const weights = useMemo(
    () => weightsFromControl(n, tTwo, puck),
    [n, tTwo, puck],
  );

  // The two trim scalars a blend does not decide (the family's hulls may disagree). This viewer holds one
  // setting for every blend it shows — the live one and every sample of the blend space — so they are
  // captured once and never move.
  const [trim] = useState(() => {
    const d = defaultHull();
    return { waterline: d.waterline, deckRake: d.deckRake };
  });

  // The blend, assembled. This app holds no store and needs none: there is one writer (the blend control) and
  // nothing to undo, so the hull is simply a value derived from the family and the weights. Its identity
  // changes with the blend, which is the redraw signal the 3D view reads — there is no version counter.
  const model = useMemo<Model>(
    () =>
      assemble(hulls.length ? blendState(hulls, weights, trim) : defaultHull()),
    [hulls, weights, trim],
  );
  const liveHydro = useMemo<Hydro | null>(
    () => (hulls.length ? hydrostatics(model) : null),
    [model, hulls.length],
  );

  // ---------- the metric heatmap / scatter axes + the shared blend-space sampling ----------
  const [heatMetric, setHeatMetric] = useState("none");
  const [scatterX, setScatterX] = useState("loverb");
  const [scatterY, setScatterY] = useState("cb");
  // samples are keyed to the exact hull array that produced them. When the family changes,
  // `samples` immediately returns NO_SAMPLES (showing "sampling…" in the scatter) until the new
  // async pass finishes — no synchronous setState needed in any effect.
  const [samplesState, setSamplesState] = useState<{
    forHulls: Hull[];
    data: Sample[];
  }>({ forHulls: [], data: [] });
  const samples =
    samplesState.forHulls === hulls ? samplesState.data : NO_SAMPLES;
  const sampling = hulls.length >= 2 && samplesState.forHulls !== hulls;
  const samplesRef = useRef<Sample[]>(NO_SAMPLES);
  useEffect(() => {
    samplesRef.current = samples;
  }, [samples]);

  // one expensive sampling pass per family, off the critical path (show the pad + 3D first, then fill). Each
  // sample assembles its own model, so the live blend is never disturbed.
  useEffect(() => {
    if (hulls.length < 2) return;
    const id = window.setTimeout(() => {
      setSamplesState({
        forHulls: hulls,
        data: computeSamples(hulls, trim),
      });
    }, 20);
    return () => clearTimeout(id);
  }, [hulls, trim]);

  // ---------- the metrics readout unit (geometry-independent; just reformats the readout — the hull's real
  // size comes from the document's own unit now) ----------
  const [unit, setUnit] = useState<Unit>("m");
  const [water, setWater] = useState<Water>("salt");

  // ---------- saving the blend to the library ----------
  const [name, setName] = useState("");
  const [save, setSave] = useState<SaveView>(INITIAL_SAVE);
  const [saving, setSaving] = useState(false);
  const idRef = useRef<BlendId>(newBlendId());
  const nameRef = useRef(name);
  const savingRef = useRef(false);
  const flashUntilRef = useRef(0); // hold a transient "Saving…" / "Saved ✓" until this timestamp
  const hullsRef = useRef(hulls); // latest family for the window listeners / async loaders / poll
  useEffect(() => {
    nameRef.current = name;
  }, [name]);
  useEffect(() => {
    hullsRef.current = hulls;
  }, [hulls]);

  const defaultBlendName = useCallback(
    () =>
      hullsRef.current.length
        ? `Blend of ${hullsRef.current.map((h) => h.name).join(" + ")}`.slice(
            0,
            120,
          )
        : "Untitled blend",
    [],
  );

  // ---------- file / library loading (additive: dropping more files grows the family, up to 5) ----------
  const finishLoad = useCallback(
    (next: Hull[], errs: string[], label: string) => {
      // reconcile the family's unit, control-point counts and station correspondence before blending
      setPromoted(promoteFamily(next.map((h) => h.data)));
      hullsRef.current = next; // keep the ref fresh for back-to-back loads
      setHulls(next);
      setTTwo(0.5); // a fresh family starts centred (equal blend)
      setPuck({ x: PADC, y: PADC });
      if (errs.length) alert(`${label}:\n\n${errs.join("\n")}`);
    },
    [],
  );

  // overlapping loads (a file dropped while the boot ?ids= fetch is in flight) are serialized through this
  // chain, so each load snapshots hullsRef.current only after the previous one has finished — the last
  // finishLoad no longer silently discards the other's hulls
  const loadChainRef = useRef<Promise<void>>(Promise.resolve());
  const enqueueLoad = useCallback((work: () => Promise<void>) => {
    loadChainRef.current = loadChainRef.current.then(work);
    return loadChainRef.current;
  }, []);

  const loadFiles = useCallback(
    (files: FileList | File[]) => {
      const list = Array.from(files); // snapshot now — a DataTransfer list may be gone by the time we run
      return enqueueLoad(async () => {
        const errs: string[] = [];
        const next = [...hullsRef.current];
        for (const f of list) {
          try {
            addParsedDoc(
              parseDocument(await f.text()),
              f.name.replace(/\.json$/i, "") || "hull",
              next,
              errs,
            );
          } catch (e) {
            errs.push(`${f.name}: ${msg(e)}`);
          }
        }
        finishLoad(next, errs, "Some files could not be loaded");
      });
    },
    [finishLoad, enqueueLoad],
  );

  const loadByIds = useCallback(
    (ids: string[]) =>
      enqueueLoad(async () => {
        const errs: string[] = [];
        const next = [...hullsRef.current];
        for (const id of ids) {
          try {
            const { name: nm, documentText } = await getDesign(id);
            addParsedDoc(parseDocument(documentText), nm, next, errs);
          } catch (e) {
            errs.push(`${id}: ${msg(e)}`);
          }
        }
        finishLoad(next, errs, "Some designs could not be loaded");
      }),
    [finishLoad, enqueueLoad],
  );

  // ---------- boot: drag-and-drop onto the page, and the ?ids= library selection ----------
  useEffect(() => {
    const stop = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const evs = ["dragenter", "dragover", "dragleave", "drop"];
    evs.forEach((ev) => document.addEventListener(ev, stop, false));
    const onDrop = (e: DragEvent) => {
      if (e.dataTransfer?.files?.length) void loadFiles(e.dataTransfer.files);
    };
    document.addEventListener("drop", onDrop);
    const ids = new URLSearchParams(window.location.search).get("ids");
    if (ids) void loadByIds(ids.split(",").filter(Boolean));
    return () => {
      evs.forEach((ev) => document.removeEventListener(ev, stop, false));
      document.removeEventListener("drop", onDrop);
    };
  }, [loadFiles, loadByIds]);

  // ---------- the one save action (reads latest state from refs) ----------
  const doSave = useCallback(async () => {
    if (savingRef.current || hullsRef.current.length < 1) return;
    savingRef.current = true;
    flashUntilRef.current = 0;
    setSaving(true);
    setSave((v) => ({ ...v, kind: "", text: "Saving…" }));
    try {
      const res = await saveBlend(
        model,
        idRef.current,
        nameRef.current,
        defaultBlendName(),
      );
      if (res) {
        idRef.current = res.id;
        setName(res.name);
        nameRef.current = res.name;
        flashUntilRef.current = Date.now() + 1400; // hold "Saved ✓" before the poll resumes
        setSave({
          buttonLabel: saveView(model, res.id, res.name, true).buttonLabel,
          kind: "saved",
          text: "Saved ✓",
        });
      } else {
        setSave(saveView(model, idRef.current, nameRef.current, true));
      }
    } catch (e) {
      setSave({
        buttonLabel: saveView(model, idRef.current, nameRef.current, true)
          .buttonLabel,
        kind: "dirty",
        text: "Save failed",
      });
      alert("Save failed: " + msg(e));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [model, defaultBlendName]);

  // ---------- the dirty poll: refresh the save indicator (skips no-op updates to avoid re-renders) ----------
  useEffect(() => {
    const iv = setInterval(() => {
      if (savingRef.current || Date.now() < flashUntilRef.current) return;
      setSave((prev) => {
        const next = saveView(
          model,
          idRef.current,
          nameRef.current,
          hullsRef.current.length > 0,
        );
        return prev.buttonLabel === next.buttonLabel &&
          prev.kind === next.kind &&
          prev.text === next.text
          ? prev
          : next;
      });
    }, 300);
    return () => clearInterval(iv);
  }, [model]);

  // ---------- warn on unsaved close ----------
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (
        isDirty(
          model,
          idRef.current,
          nameRef.current,
          hullsRef.current.length > 0,
        )
      ) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [model]);

  // ---------- handlers ----------
  const onEqualize = () => {
    setTTwo(0.5);
    setPuck({ x: PADC, y: PADC });
  };
  const onClose = () => {
    if (
      isDirty(
        model,
        idRef.current,
        nameRef.current,
        hullsRef.current.length > 0,
      ) &&
      !confirm("Discard the unsaved blend and return to the library?")
    )
      return;
    window.location.href = "library.html";
  };
  // jump the blend control to a sampled point (clicked in the scatter)
  const onJump = useCallback((i: number) => {
    const smp = samplesRef.current[i];
    if (!smp) return;
    if (hullsRef.current.length === 2) setTTwo(smp.t);
    else setPuck({ ...smp.pos });
  }, []);

  return (
    <>
      <header>
        <h1>Hull interpolation blender</h1>
        <p>
          Blend between the chosen hulls — a slider for two, or drag the dot in
          the blend pad for three or more. Every blend of valid hulls of the
          same topology is itself a valid hull. Name it and use{" "}
          <strong>Save As</strong> to store the result as a new design in the
          library.
        </p>
      </header>
      <div className="wrap">
        <div className="card">
          <div className="barrow">
            <FilenameInput
              value={name}
              placeholder="Untitled blend"
              title="Name for the saved blend"
              onChange={setName}
            />
            <span className={"savestate" + (save.kind ? " " + save.kind : "")}>
              {save.text}
            </span>
            <Button
              variant="primary"
              title="Save the current blend as a new design in the library"
              disabled={n < 1 || saving}
              onClick={() => void doSave()}
            >
              {save.buttonLabel}
            </Button>
            <Button title="Reset all weights to equal" onClick={onEqualize}>
              Equalize weights
            </Button>
            <span style={{ flex: 1 }} />
            <Button
              title="Close and return to the design library"
              onClick={onClose}
            >
              Close
            </Button>
          </div>
        </div>

        <div className="row">
          <div className="main">
            <div className="view3dwrap">
              {n >= 1 ? (
                <View3d title="Blended Hull" model={model} selection={null} />
              ) : (
                <div className="top3d">
                  <div className="view3dtitle">Blended Hull</div>
                </div>
              )}
            </div>
            <BlendExplorer
              samples={samples}
              sampling={sampling}
              liveHydro={liveHydro}
              scatterX={scatterX}
              scatterY={scatterY}
              onScatterX={setScatterX}
              onScatterY={setScatterY}
              onJump={onJump}
            />
          </div>
          <div className="side">
            <BlendControl
              hulls={hulls}
              weights={weights}
              promoted={promoted}
              tTwo={tTwo}
              puck={puck}
              onTTwo={setTTwo}
              onPuck={setPuck}
              samples={samples}
              heatMetric={heatMetric}
              onHeatMetric={setHeatMetric}
            />
            <MetricsPanel
              hydro={liveHydro}
              docUnit={hulls.length ? hulls[0].data.unit : model.unit}
              unit={unit}
              water={water}
              onUnit={setUnit}
              onWater={setWater}
            />
          </div>
        </div>
      </div>
    </>
  );
}

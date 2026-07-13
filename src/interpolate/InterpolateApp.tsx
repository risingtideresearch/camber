import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createModel, prepare, L, type Model } from "../core/model";
import { hydrostatics, type Hydro } from "../core/hydro";
import { parseDocument, type ParsedDoc } from "../core/json";
import { promoteFamily } from "../core/promote";
import { getDesign } from "../core/supabase";
import { View3d } from "../components/View3d";
import { Button } from "../components/Button";
import { FilenameInput } from "../components/FilenameInput";
import {
  blend,
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
import {
  MetricsPanel,
  type Unit,
  type Water,
} from "../components/MetricsPanel";
import { WavePanel } from "./WavePanel";
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

// add every variant of a parsed document to the family (a document can carry several), checking each against
// the shared length. Collects any per-variant problems into `errs`. Mutates `hulls` and `famLength`.
function addParsedDoc(
  parsed: ParsedDoc,
  base: string,
  hulls: Hull[],
  famLength: { current: number | null },
  errs: string[],
): void {
  let vi = 0;
  for (const data of parsed.variants) {
    if (hulls.length >= 5) {
      errs.push(
        `${base}: family is full (max 5 hulls) — some variants skipped`,
      );
      break;
    }
    if (famLength.current == null) famLength.current = parsed.length;
    else if (Math.abs(parsed.length - famLength.current) > 1e-6) {
      errs.push(
        `${base}: length mismatch — ${parsed.length} vs the family's ${famLength.current}. Lengths must match.`,
      );
      vi++;
      continue;
    }
    const name =
      data.name ?? (parsed.variants.length > 1 ? `${base} #${vi + 1}` : base);
    hulls.push({ name, data });
    vi++;
  }
}

export function InterpolateApp() {
  // the one hull model: a stable, mutable object (the blend is written into it). It is never replaced; the
  // blend is (re)computed during render (below), so the model is always current before any child effect draws.
  const [model] = useState<Model>(() => {
    const m = createModel();
    m.x0 = L / 2;
    return m;
  });

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

  // (re)blend + prepare during render, and read the live hydrostatics. Doing this in a render-phase memo (like
  // the editor's section sampling) keeps the model current before the 3D view's draw effect runs.
  const [modelVersion, setModelVersion] = useState(0);
  const liveHydro = useMemo<Hydro | null>(() => {
    if (!hulls.length) return null;
    blend(model, hulls, weights);
    prepare(model);
    return hydrostatics(model);
  }, [model, hulls, weights]);
  // bump modelVersion after each blend so View3d's draw effect re-runs with the updated model
  useEffect(() => {
    if (!liveHydro) return;
    const id = window.setTimeout(() => setModelVersion((v) => v + 1), 0);
    return () => clearTimeout(id);
  }, [liveHydro]);

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

  // one expensive sampling pass per family, off the critical path (show the pad + 3D first, then fill). Uses a
  // dedicated scratch model so the live blend is never disturbed.
  const scratch = useMemo<Model>(() => {
    const m = createModel();
    m.x0 = L / 2;
    return m;
  }, []);
  useEffect(() => {
    if (hulls.length < 2) return;
    const id = window.setTimeout(() => {
      setSamplesState({
        forHulls: hulls,
        data: computeSamples(scratch, hulls),
      });
    }, 20);
    return () => clearTimeout(id);
  }, [hulls, scratch]);

  // ---------- the metrics length scale (geometry-independent; just reformats the readout) ----------
  const [loa, setLoa] = useState(12);
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
  const famLengthRef = useRef<number | null>(null);
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
      // lift any mixed topologies to a common one before blending
      setPromoted(
        promoteFamily(
          model,
          next.map((h) => h.data),
        ),
      );
      hullsRef.current = next; // keep the ref fresh for back-to-back loads
      setHulls(next);
      setTTwo(0.5); // a fresh family starts centred (equal blend)
      setPuck({ x: PADC, y: PADC });
      if (errs.length) alert(`${label}:\n\n${errs.join("\n")}`);
    },
    [model],
  );

  const loadFiles = useCallback(
    async (files: FileList | File[]) => {
      const errs: string[] = [];
      const next = [...hullsRef.current];
      for (const f of Array.from(files)) {
        try {
          addParsedDoc(
            parseDocument(model, await f.text()),
            f.name.replace(/\.json$/i, "") || "hull",
            next,
            famLengthRef,
            errs,
          );
        } catch (e) {
          errs.push(`${f.name}: ${msg(e)}`);
        }
      }
      finishLoad(next, errs, "Some files could not be loaded");
    },
    [model, finishLoad],
  );

  const loadByIds = useCallback(
    async (ids: string[]) => {
      const errs: string[] = [];
      const next = [...hullsRef.current];
      for (const id of ids) {
        try {
          const { name: nm, documentText } = await getDesign(id);
          addParsedDoc(
            parseDocument(model, documentText),
            nm,
            next,
            famLengthRef,
            errs,
          );
        } catch (e) {
          errs.push(`${id}: ${msg(e)}`);
        }
      }
      finishLoad(next, errs, "Some designs could not be loaded");
    },
    [model, finishLoad],
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
                <View3d
                  title="Blended Hull"
                  model={model}
                  modelVersion={modelVersion}
                  selection={null}
                />
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
              loa={loa}
              unit={unit}
              water={water}
              onLoa={setLoa}
              onUnit={setUnit}
              onWater={setWater}
            />
            <WavePanel
              model={model}
              modelVersion={modelVersion}
              active={n >= 1 && !!liveHydro?.validWaterplane}
              loa={loa}
              unit={unit}
              water={water}
            />
          </div>
        </div>
      </div>
    </>
  );
}

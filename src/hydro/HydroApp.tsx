import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createModel, resetModel, type Model } from "../core/model";
import { loadJsonText } from "../core/json";
import { openDesign } from "../editor/save";
import {
  parseStl,
  defaultStlSettings,
  AXES,
  type Axis,
  type StlState,
} from "../core/stlImport";
import { subjectMesh } from "../core/mesh";
import {
  weightSummary,
  solveFlotation,
  defaultWeightsState,
  type WeightsState,
  type WeightItem,
} from "../core/weights";
import { AnalysisPanel } from "../editor/AnalysisPanel";
import { HydroView2d } from "./HydroView2d";
import { TopBar } from "../components/TopBar";
import "./HydroApp.css";

// The dedicated hydrostatics page: pick a hull (import an STL, open a saved hull JSON, load a library design by
// ?id=, or use the built-in default), then read its displacement, CG, and free-floating equilibrium. The STL,
// when present, IS the analysed hull; otherwise the parametric hull is. Both go through the one mesh engine.
export function HydroApp() {
  const [model] = useState<Model>(() => {
    const m = createModel();
    resetModel(m);
    return m;
  });
  const [modelVersion, setModelVersion] = useState(0);
  const bumpModel = useCallback(() => setModelVersion((v) => v + 1), []);
  const [stl, setStl] = useState<StlState | null>(null);
  const [label, setLabel] = useState("default hull");
  const [weights, setWeights] = useState<WeightsState>(defaultWeightsState);
  const onWeights = useCallback(
    (patch: Partial<WeightsState>) => setWeights((w) => ({ ...w, ...patch })),
    [],
  );
  const onMoveItem = useCallback(
    (id: string, patch: Partial<WeightItem>) =>
      setWeights((w) => ({
        ...w,
        items: w.items.map((it) => (it.id === id ? { ...it, ...patch } : it)),
      })),
    [],
  );
  const stlInput = useRef<HTMLInputElement>(null);
  const jsonInput = useRef<HTMLInputElement>(null);

  // load a library design if the page was opened with ?id= (backend-dependent; non-fatal if it fails)
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("id");
    if (!id) return;
    void (async () => {
      try {
        const name = await openDesign(model, id);
        setStl(null);
        setLabel(name || "design");
        bumpModel();
      } catch (e) {
        console.error("open design failed:", e);
      }
    })();
  }, [model, bumpModel]);

  const onImportStl = async (file: File): Promise<void> => {
    try {
      const geom = parseStl(await file.arrayBuffer());
      setStl({
        geom,
        designBox: [0, 0, 0, 1, 1, 1],
        settings: defaultStlSettings(geom, [0, 0, 0, 1, 1, 1]),
      });
      setLabel(file.name);
    } catch (e) {
      alert(
        "Couldn't import STL: " + (e instanceof Error ? e.message : String(e)),
      );
    }
  };
  const onOpenJson = async (file: File): Promise<void> => {
    try {
      loadJsonText(model, await file.text());
      setStl(null);
      setLabel(file.name);
      bumpModel();
    } catch (e) {
      alert(
        "Couldn't open hull JSON: " +
          (e instanceof Error ? e.message : String(e)),
      );
    }
  };
  const onUseDefault = (): void => {
    resetModel(model);
    setStl(null);
    setLabel("default hull");
    bumpModel();
  };
  const setAxis = (which: "axisX" | "axisY" | "axisZ", v: Axis): void =>
    setStl((s) => (s ? { ...s, settings: { ...s.settings, [which]: v } } : s));

  // ---- the analysis pipeline ----
  const mesh = useMemo(
    () => subjectMesh(model, stl, weights.loa),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, modelVersion, stl, weights.loa],
  );
  const summary = useMemo(() => weightSummary(mesh, weights), [mesh, weights]);
  const flotation = useMemo(
    () => solveFlotation(mesh, summary, weights.water),
    [mesh, summary, weights.water],
  );

  return (
    <div className="hydroapp">
      <TopBar className="hydrobar">
        <span className="hydrotitle">Hydrostatics</span>
        <span className="tabsep" />
        <button className="hydrobtn" onClick={() => stlInput.current?.click()}>
          Import STL…
        </button>
        <button className="hydrobtn" onClick={() => jsonInput.current?.click()}>
          Open hull JSON…
        </button>
        <button className="hydrobtn" onClick={onUseDefault}>
          Default hull
        </button>
        <input
          ref={stlInput}
          type="file"
          accept=".stl"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onImportStl(f);
            e.target.value = "";
          }}
        />
        <input
          ref={jsonInput}
          type="file"
          accept=".json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onOpenJson(f);
            e.target.value = "";
          }}
        />
        <span className="hydrosubject" title="The hull being analysed">
          {stl ? "STL: " : ""}
          {label}
        </span>
        {stl && (
          <span
            className="hydroaxes"
            title="Map the STL's axes into the hull frame (x = length, y = beam, z = up)"
          >
            axes
            {(["axisX", "axisY", "axisZ"] as const).map((k) => (
              <select
                key={k}
                value={stl.settings[k]}
                onChange={(e) => setAxis(k, e.target.value as Axis)}
              >
                {AXES.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            ))}
          </span>
        )}
        <span className="spacer" />
        <a className="hydrolink" href="library.html">
          ← Library
        </a>
      </TopBar>
      <div className="hydromain">
        <div className="hydroleft">
          <HydroView2d
            mesh={mesh}
            flotation={flotation}
            items={weights.items}
            onMoveItem={onMoveItem}
          />
        </div>
        <div className="hydroright">
          <AnalysisPanel
            subjectLabel={stl ? "STL" : "parametric"}
            hasStl={!!stl}
            weights={weights}
            summary={summary}
            flotation={flotation}
            onWeights={onWeights}
          />
        </div>
      </div>
    </div>
  );
}

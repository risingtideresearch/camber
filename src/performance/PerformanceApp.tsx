import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createModel,
  resetModel,
  prepare,
  setWaterline,
  setDeckRake,
  type Model,
} from "../core/model";
import { hydrostatics, type Hydro } from "../core/hydro";
import { parseDocument, loadHull } from "../core/json";
import { getDesign } from "../core/supabase";
import { View3d } from "../components/View3d";
import { Button } from "../components/Button";
import {
  MetricsPanel,
  type Unit,
  type Water,
} from "../components/MetricsPanel";
import { PowerPanel } from "./PowerPanel";
import "./PerformanceApp.css";

// The performance viewer: open any camber design (from the library via ?id=, a dropped JSON file, or the
// file picker), set the waterline / trim and the real-world scale, and read the result — displacement and
// the other hydrostatics, plus the effective speed/power curve. Analysis only: nothing here edits the
// design or saves anything. Like the other apps it owns one stable, mutable model; the version counter
// drives reactivity.

const msg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

export function PerformanceApp() {
  // the one hull model, starting as the built-in default so the page is alive before any load
  const [model] = useState<Model>(() => {
    const m = createModel();
    resetModel(m);
    prepare(m);
    return m;
  });
  const [name, setName] = useState("Default hull");
  const [version, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);

  // trim state mirrors the model (the model is the source of truth; these exist to re-render the labels)
  const [wl, setWl] = useState(model.waterline);
  const [rakeDeg, setRakeDeg] = useState((model.deckRake * 180) / Math.PI);

  // the metrics length scale
  const [loa, setLoa] = useState(12);
  const [unit, setUnit] = useState<Unit>("m");
  const [water, setWater] = useState<Water>("salt");

  const hydro = useMemo<Hydro | null>(
    () => hydrostatics(model),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, version],
  );

  // ---------- loading ----------
  const loadText = useCallback(
    (text: string, label: string) => {
      try {
        const parsed = parseDocument(model, text);
        loadHull(model, parsed.variants[0]);
        prepare(model);
        setName(parsed.variants[0].name ?? label);
        setWl(model.waterline);
        setRakeDeg((model.deckRake * 180) / Math.PI);
        bump();
      } catch (e) {
        alert(`${label}: ${msg(e)}`);
      }
    },
    [model],
  );
  const loadTextRef = useRef(loadText);
  useEffect(() => {
    loadTextRef.current = loadText;
  }, [loadText]);

  const openPicker = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (f) loadText(await f.text(), f.name.replace(/\.json$/i, ""));
    };
    input.click();
  };

  // boot: drag-and-drop onto the page, and the ?id= library selection
  useEffect(() => {
    const stop = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const evs = ["dragenter", "dragover", "dragleave", "drop"];
    evs.forEach((ev) => document.addEventListener(ev, stop, false));
    const onDrop = (e: DragEvent) => {
      const f = e.dataTransfer?.files?.[0];
      if (f)
        void f
          .text()
          .then((t) => loadTextRef.current(t, f.name.replace(/\.json$/i, "")));
    };
    document.addEventListener("drop", onDrop);
    const id = new URLSearchParams(window.location.search).get("id");
    if (id)
      void getDesign(id)
        .then(({ name: nm, documentText }) => {
          loadTextRef.current(documentText, nm);
          setName(nm);
        })
        .catch((e) => alert(`Could not load design: ${msg(e)}`));
    return () => {
      evs.forEach((ev) => document.removeEventListener(ev, stop, false));
      document.removeEventListener("drop", onDrop);
    };
  }, []);

  // ---------- trim handlers ----------
  const onWaterline = (v: number) => {
    setWaterline(model, v);
    setWl(v);
    bump();
  };
  const onRake = (deg: number) => {
    setDeckRake(model, deg);
    setRakeDeg(deg);
    bump();
  };

  return (
    <>
      <header>
        <h1>Hull performance</h1>
        <p>
          Open any camber design — from the library, or drop its JSON here —
          then set the waterline and the real length it will be built to. The
          panels show the displacement and hydrostatics at that trim and the
          effective power needed to drive the hull through its speed range.
        </p>
      </header>
      <div className="wrap">
        <div className="card">
          <div className="barrow">
            <span className="designname" title="The loaded design">
              {name}
            </span>
            <span style={{ flex: 1 }} />
            <Button
              title="Open a design JSON file (or drag one anywhere onto the page)"
              onClick={openPicker}
            >
              Open JSON…
            </Button>
            <Button
              title="Back to the design library"
              onClick={() => (window.location.href = "library.html")}
            >
              Library
            </Button>
          </div>
        </div>

        <div className="row">
          <div className="main">
            <div className="view3dwrap">
              <View3d
                title={name}
                model={model}
                modelVersion={version}
                selection={null}
              />
            </div>
            <PowerPanel
              model={model}
              modelVersion={version}
              active={!!hydro?.validWaterplane}
              loa={loa}
              unit={unit}
              water={water}
            />
          </div>
          <div className="side">
            <div className="card">
              <div className="cap">
                <span>Trim</span>
              </div>
              <div className="ctl">
                <label
                  className="trimrow"
                  title="Design waterline — depth below the sheer origin (deck datum)"
                >
                  WL
                  <input
                    type="range"
                    min="0"
                    max="1400"
                    step="10"
                    value={wl}
                    onChange={(e) => onWaterline(parseFloat(e.target.value))}
                  />
                  <span className="trimval">{Math.round(wl)}</span>
                </label>
                <label
                  className="trimrow"
                  title="Deck rake — bow-up trim angle; rotates the whole hull about the sheer origin"
                >
                  Rake
                  <input
                    type="range"
                    min="-12"
                    max="12"
                    step="0.5"
                    value={rakeDeg}
                    onChange={(e) => onRake(parseFloat(e.target.value))}
                  />
                  <span className="trimval">{rakeDeg.toFixed(1)}°</span>
                </label>
                <div className="hint">
                  Waterline and rake are in model units / degrees, applied live.
                  They start at the design&apos;s saved trim.
                </div>
              </div>
            </div>
            <MetricsPanel
              hydro={hydro}
              loa={loa}
              unit={unit}
              water={water}
              onLoa={setLoa}
              onUnit={setUnit}
              onWater={setWater}
            />
          </div>
        </div>
      </div>
    </>
  );
}

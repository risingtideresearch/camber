import { useEffect, useRef, useState } from "react";
import { Button } from "./Button";
import { AXES, type Axis, type StlSettings } from "../core/stlImport";
import { useEditorUi } from "../editor/editorUi";
import "./StlControl.css";

// The appbar STL control. Before a file is loaded it is a single "STL Import" button; once a mesh is
// imported it becomes a split control: a "Show STL" toggle joined to a ▾ button that opens a dropdown of
// display settings (axis remap, scale, opacity, wireframe / shaded, and Remove). Purely presentational —
// EditorApp owns the StlState and applies every change.

export function StlControl() {
  const {
    stl,
    importStl: onImport,
    changeStl: onChange,
    removeStl: onRemove,
  } = useEditorUi();
  const fileRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  // close the dropdown on an outside click or Escape
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) onImport(f);
    e.target.value = ""; // allow re-importing the same file
  };

  return (
    <div className="stlctl" ref={rootRef}>
      <input
        ref={fileRef}
        type="file"
        accept=".stl,model/stl"
        style={{ display: "none" }}
        onChange={pickFile}
      />
      {!stl ? (
        <Button
          title="Import an STL to overlay on the 3D view (session only — not saved)"
          onClick={() => fileRef.current?.click()}
        >
          STL Import
        </Button>
      ) : (
        <div className="stlsplit">
          <Button
            className="stltoggle"
            active={stl.settings.visible}
            title="Show / hide the imported STL in the 3D view"
            onClick={() => onChange({ visible: !stl.settings.visible })}
          >
            Show STL
          </Button>
          <Button
            className="stlcaret"
            active={open}
            title="STL display settings"
            onClick={() => setOpen((v) => !v)}
          >
            ▾
          </Button>
          {open && (
            <StlPanel
              settings={stl.settings}
              onChange={onChange}
              onRemove={() => {
                setOpen(false);
                onRemove();
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

const AXIS_LABEL: { world: "axisX" | "axisY" | "axisZ"; label: string }[] = [
  { world: "axisX", label: "X (length)" },
  { world: "axisY", label: "Y (breadth)" },
  { world: "axisZ", label: "Z (up)" },
];

function StlPanel({
  settings,
  onChange,
  onRemove,
}: {
  settings: StlSettings;
  onChange: (patch: Partial<StlSettings>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="stlpanel">
      <div className="stlrow stlrow-head">Axis mapping</div>
      {AXIS_LABEL.map(({ world, label }) => (
        <label className="stlrow" key={world}>
          <span>{label}</span>
          <select
            value={settings[world]}
            onChange={(e) => onChange({ [world]: e.target.value as Axis })}
          >
            {AXES.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
      ))}

      <label className="stlrow">
        <span>Scale</span>
        <input
          type="number"
          step="0.01"
          min="0"
          value={settings.scale}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v > 0) onChange({ scale: v });
          }}
        />
      </label>

      <label className="stlrow">
        <span>Opacity</span>
        <input
          type="range"
          min="0.05"
          max="1"
          step="0.05"
          value={settings.opacity}
          onChange={(e) => onChange({ opacity: Number(e.target.value) })}
        />
        <span className="stlnum">{Math.round(settings.opacity * 100)}%</span>
      </label>

      <div className="stlrow stlrow-checks">
        <label>
          <input
            type="checkbox"
            checked={settings.shaded}
            onChange={(e) => onChange({ shaded: e.target.checked })}
          />
          Shaded
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings.wireframe}
            onChange={(e) => onChange({ wireframe: e.target.checked })}
          />
          Wireframe
        </label>
      </div>

      <div className="stlrow stlrow-foot">
        <Button variant="danger" onClick={onRemove}>
          Remove STL
        </Button>
      </div>
    </div>
  );
}

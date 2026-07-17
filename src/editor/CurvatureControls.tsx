import { useState } from "react";
import { Dropdown } from "../components/Dropdown";
import type { CurvatureSettings } from "../core/comb";

// The app-bar "Curvature" control: a toggle button that shows / hides the curvature-comb overlays across all
// views, plus a dropdown that picks which combs are drawn and how dense they are. State lives in EditorApp
// (so every view can read it); this component just presents it and pushes edits back up through `onChange`.
interface CurvatureControlsProps {
  value: CurvatureSettings;
  onChange: (next: CurvatureSettings) => void;
}

// the checkbox rows, grouped by view. Each entry is [settings key, label]; a null row starts a new group.
type BoolKey = {
  [K in keyof CurvatureSettings]: CurvatureSettings[K] extends boolean
    ? K
    : never;
}[keyof CurvatureSettings];
type NumKey = {
  [K in keyof CurvatureSettings]: CurvatureSettings[K] extends number
    ? K
    : never;
}[keyof CurvatureSettings];

const GROUPS: { title: string; rows: [BoolKey, string][] }[] = [
  {
    title: "Plan View",
    rows: [
      ["planSheer", "Sheer plan"],
      ["planWaterline", "Waterline"],
    ],
  },
  {
    title: "Profile View",
    rows: [
      ["profSheer", "Sheer trim"],
      ["profCenterline", "Centerline"],
      ["profCut", "Cut section"],
    ],
  },
  {
    title: "Stations",
    rows: [
      ["stnSelected", "Selected station"],
      ["stnUnselected", "Unselected stations"],
    ],
  },
  {
    title: "Cut Section",
    rows: [["cutSection", "Lofted section"]],
  },
  {
    title: "3D View",
    rows: [
      ["d3Sheer", "Sheer"],
      ["d3Centerline", "Centerline"],
      ["d3Longitudinals", "Longitudinals"],
      ["d3Sections", "Sections"],
    ],
  },
];

const SLIDERS: {
  key: NumKey;
  label: string;
  min: number;
  max: number;
  step: number;
  title: string;
}[] = [
  {
    key: "nLongHairs",
    label: "Num longitudinal hairs",
    min: 4,
    max: 120,
    step: 2,
    title:
      "Hairs per fore-aft comb (sheer plan, waterline, sheer trim, 2D & 3D centerline, 3D sheer & longitudinals)",
  },
  {
    key: "nSectHairs",
    label: "Num section hairs",
    min: 4,
    max: 100,
    step: 2,
    title: "Hairs per transverse comb (stations, cut sections, 3D sections)",
  },
  {
    key: "nLongCombs",
    label: "Num longitudinal combs",
    min: 0,
    max: 24,
    step: 1,
    title: "How many fore-aft longitudinal curves get a comb in the 3D view",
  },
  {
    key: "nSectCombs",
    label: "Num section combs",
    min: 0,
    max: 40,
    step: 1,
    title: "How many transverse section curves get a comb in the 3D view",
  },
];

export function CurvatureControls({ value, onChange }: CurvatureControlsProps) {
  const [open, setOpen] = useState(false);
  const setBool = (k: BoolKey, v: boolean) => onChange({ ...value, [k]: v });
  const setNum = (k: NumKey, v: number) => onChange({ ...value, [k]: v });

  return (
    <Dropdown
      label="Curvature"
      active={value.on}
      onToggle={() => onChange({ ...value, on: !value.on })}
      open={open}
      onOpenChange={setOpen}
      title="Show curvature combs across the views (toggle); the caret picks which combs and how dense"
      menuLabel="Curvature options"
    >
      {GROUPS.map((g) => (
        <div key={g.title} className="dd-section">
          <div className="dd-group">{g.title}</div>
          {g.rows.map(([key, label]) => (
            <label key={key} className="dd-row dd-check">
              <input
                type="checkbox"
                checked={value[key]}
                onChange={(e) => setBool(key, e.target.checked)}
              />
              <span className="dd-name">{label}</span>
            </label>
          ))}
        </div>
      ))}
      <div className="dd-group">Density</div>
      {SLIDERS.map((s) => (
        <label key={s.key} className="dd-row" title={s.title}>
          <span className="dd-name">{s.label}</span>
          <input
            type="range"
            min={s.min}
            max={s.max}
            step={s.step}
            value={value[s.key]}
            onChange={(e) => setNum(s.key, +e.target.value)}
          />
          <span className="dd-val">{value[s.key]}</span>
        </label>
      ))}
    </Dropdown>
  );
}

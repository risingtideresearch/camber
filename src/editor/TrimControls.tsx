import { loa } from "../core/model";
import { UNITS, type Unit } from "../core/document";
import { useDocumentDispatch, useDocumentRuntime } from "./documentStoreHooks";
import "./TrimControls.css";

// The design-waterline and deck-rake sliders, plus the document's unit. React-owned: their values are read
// from the model (the single source of truth) and each change pushes back to the model, which triggers a
// redraw everywhere.

export function TrimControls() {
  const model = useDocumentRuntime();
  const dispatch = useDocumentDispatch();
  const onWaterline = (depth: number) =>
    void dispatch({ type: "setWaterline", depth });
  const onRake = (deg: number) =>
    void dispatch({ type: "setDeckRakeDeg", deg });
  // Changing the unit asks which of the two things the user meant: keep the hull the same PHYSICAL size and
  // convert the numbers (2000 mm → 2 m), or keep the numbers and reinterpret them at the new unit's scale
  // (2000 mm → 2000 m). Neither is a safe default, so it is asked rather than assumed.
  const onUnit = (unit: Unit) => {
    if (unit === model.unit) return;
    const rescale = confirm(
      `Change the unit from ${model.unit} to ${unit}.

` +
        `OK — convert the numbers, keeping the hull the same size.
` +
        `Cancel — keep the numbers, resizing the hull to ${unit}.`,
    );
    void dispatch({ type: "setUnit", unit, rescale });
  };
  const waterline = model.waterline; // depth below the sheer origin (deck datum), in model.unit
  const rakeDeg = (model.deckRake * 180) / Math.PI;
  // the slider's range is a proportion of the hull's own length — the coordinates are absolute in the
  // document's unit now, so a fixed 0..1400 would be most of a 1000 mm dinghy and nothing on a 12 m boat
  const len = loa(model) || 1,
    wlMax = 1.4 * len,
    wlStep = len / 1000;

  return (
    <>
      <label
        className="ctl"
        title="Design waterline — depth below the sheer origin (deck datum), in the document's unit"
      >
        WL
        <input
          type="range"
          min="0"
          max={wlMax}
          step={wlStep}
          value={waterline}
          onChange={(e) => onWaterline(parseFloat(e.target.value))}
        />
        <span className="ctlval">
          {waterline >= 100 ? waterline.toFixed(0) : waterline.toFixed(2)}
        </span>
      </label>
      <label
        className="ctl"
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
        <span className="ctlval">{rakeDeg.toFixed(1)}°</span>
      </label>
      <label
        className="ctl"
        title="The unit every coordinate in this document is stated in. Changing it asks whether to convert the numbers (keeping the hull's size) or to reinterpret them (resizing the hull)."
      >
        Unit
        <select
          value={model.unit}
          onChange={(e) => onUnit(e.target.value as Unit)}
        >
          {UNITS.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

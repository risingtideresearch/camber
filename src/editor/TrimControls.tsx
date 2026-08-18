import { useState } from "react";
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
  // The hull's own size, typed rather than dragged. A document is often authored as a SHAPE — the plan
  // running 0…1000 — and every dimensional answer taken off it (displacement in tonnes, KG, the area under
  // GZ) is that shape's number times however long the boat really is. Stating the length overall here is
  // that multiplication, applied to the hull itself: it scales every coordinate by one factor, so the shape
  // is untouched and the numbers become the real ones. Held locally until Enter or blur, because rescaling
  // the whole boat on every keystroke of "37000" would walk it through 3, 37, 370 mm on the way.
  const [typedLoa, setTypedLoa] = useState<string | null>(null);
  const commitLoa = () => {
    const length = parseFloat(typedLoa ?? "");
    setTypedLoa(null);
    if (Number.isFinite(length) && length > 0 && length !== loa(model))
      void dispatch({ type: "setLoa", length });
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
        title="Length overall — scales the whole hull to this length, keeping its shape exactly. Every dimensional result (displacement, KG, the area under GZ) is read against it."
      >
        LOA
        <input
          className="ctlnum"
          type="number"
          min="0"
          step={len / 100}
          value={typedLoa ?? (len >= 100 ? len.toFixed(0) : len.toFixed(2))}
          onChange={(e) => setTypedLoa(e.target.value)}
          onBlur={commitLoa}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setTypedLoa(null);
          }}
        />
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

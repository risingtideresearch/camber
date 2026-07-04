import type { Model } from "../core/model";
import "./TrimControls.css";

// The design-waterline and deck-rake sliders. React-owned: their values are read from the model (the single
// source of truth) and each change pushes back to the model, which triggers a redraw everywhere.
interface TrimControlsProps {
  model: Model;
  onWaterline: (mm: number) => void;
  onRake: (deg: number) => void;
}

export function TrimControls({
  model,
  onWaterline,
  onRake,
}: TrimControlsProps) {
  const waterline = model.waterline; // mm below the sheer origin
  const rakeDeg = (model.deckRake * 180) / Math.PI;

  return (
    <>
      <label
        className="ctl"
        title="Design waterline — depth below the sheer origin (deck datum)"
      >
        WL
        <input
          type="range"
          id="wlRange"
          min="0"
          max="1400"
          step="10"
          value={waterline}
          onChange={(e) => onWaterline(parseFloat(e.target.value))}
        />
        <span className="ctlval" id="wlVal">
          {Math.round(waterline)}
        </span>
      </label>
      <label
        className="ctl"
        title="Deck rake — bow-up trim angle; rotates the whole hull about the sheer origin"
      >
        Rake
        <input
          type="range"
          id="rakeRange"
          min="-12"
          max="12"
          step="0.5"
          value={rakeDeg}
          onChange={(e) => onRake(parseFloat(e.target.value))}
        />
        <span className="ctlval" id="rakeVal">
          {rakeDeg.toFixed(1)}°
        </span>
      </label>
    </>
  );
}

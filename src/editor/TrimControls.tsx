import "./TrimControls.css";

// The design-waterline and deck-rake sliders. React-owned: the values are React state (mirroring
// `state.waterline` / `state.deckRake`), and each change pushes to the controller, which mutates the
// model and re-renders. These ids touch no imperative code, so React controls them fully.
interface TrimControlsProps {
  waterline: number; // mm below the sheer origin
  rakeDeg: number; // deck rake in degrees
  onWaterline: (mm: number) => void;
  onRake: (deg: number) => void;
}

export function TrimControls({
  waterline,
  rakeDeg,
  onWaterline,
  onRake,
}: TrimControlsProps) {
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

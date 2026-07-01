import "./SelectionInfo.css";

// The contextual selection readout: label, knuckle slider, delete. Static markup — `interaction.ts`
// owns it entirely (`refreshSelUI()` sets `#selLabel` text + the disabled states / slider value, and
// `initInteraction()` wires the `#selKnuckle` input and `#selDelete` click). The inputs are left
// uncontrolled so React doesn't fight those imperative `.value` / `.disabled` writes.
export function SelectionInfo() {
  return (
    <div className="selinfo" id="selinfo">
      <span className="sel-label muted" id="selLabel">
        No point selected
      </span>
      <label className="sel-knuckle" id="selKnuckleWrap">
        Knuckle
        <input
          type="range"
          id="selKnuckle"
          min="0"
          max="1"
          step="0.01"
          title="0 = smooth · 1 = hard corner"
        />
      </label>
      <button
        id="selDelete"
        title="Delete the selected point (Delete / Backspace)"
      >
        Delete
      </button>
    </div>
  );
}

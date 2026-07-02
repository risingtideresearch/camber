import type { Model } from "../core/model";
import type { ModelSelection } from "../core/modelSelection";
import { canDelete, hasKnuckle, labelFor, selArr } from "./selection";
import "./SelectionInfo.css";

// The contextual selection readout: label, knuckle slider, delete — all derived from the current selection.
// The panel keeps constant height (the slider and delete are present but disabled when they don't apply) so
// selecting a point never reflows the app bar.
interface SelectionInfoProps {
  model: Model;
  selection: ModelSelection;
  onKnuckle: (k: number) => void;
  onDelete: () => void;
}

export function SelectionInfo({
  model,
  selection,
  onKnuckle,
  onDelete,
}: SelectionInfoProps) {
  const arr = selArr(model, selection);
  const knuckle = !!(selection && arr && hasKnuckle(selection));
  const knuckleVal = knuckle ? arr![selection!.idx].k : 0;
  const deletable = !!selection && canDelete(model, selection);

  return (
    <div className="selinfo" id="selinfo">
      <span className={"sel-label" + (selection ? "" : " muted")} id="selLabel">
        {selection ? labelFor(selection) : "No point selected"}
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
          value={knuckleVal}
          disabled={!knuckle}
          onChange={(e) => onKnuckle(parseFloat(e.target.value))}
        />
      </label>
      <button
        id="selDelete"
        title="Delete the selected point (Delete / Backspace)"
        disabled={!deletable}
        onClick={onDelete}
      >
        Delete
      </button>
    </div>
  );
}

import { Button } from "../components/Button";
import {
  canDelete,
  deleteCommand,
  hasKnuckle,
  knuckleCommand,
  labelFor,
  selArr,
} from "./selection";
import { useDispatch, useRuntime } from "./hullStore";
import { useEditorUi } from "./editorUi";
import "./SelectionInfo.css";

// The contextual selection readout: label, knuckle slider, delete — all derived from the current selection.
// The panel keeps constant height (the slider and delete are present but disabled when they don't apply) so
// selecting a point never reflows the app bar.

export function SelectionInfo() {
  const model = useRuntime();
  const dispatch = useDispatch();
  const { selection, setSelection } = useEditorUi();
  // The selection is window-local and must never travel in a command, so it is resolved to one here.
  const onKnuckle = (k: number) => {
    const cmd = knuckleCommand(model, selection, k);
    if (cmd) void dispatch(cmd);
  };
  const onDelete = () => {
    const cmd = deleteCommand(model, selection);
    if (!cmd) return;
    setSelection(null);
    void dispatch(cmd);
  };
  const arr = selArr(model, selection);
  const knuckle = !!(selection && arr && hasKnuckle(selection));
  const knuckleVal = knuckle ? arr![selection!.idx].k : 0;
  const deletable = !!selection && canDelete(model, selection);

  return (
    <div className="selinfo">
      <span className={"sel-label" + (selection ? "" : " muted")}>
        {selection ? labelFor(selection) : "No point selected"}
      </span>
      <label className="sel-knuckle">
        Knuckle
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          title="0 = smooth · 1 = hard corner"
          value={knuckleVal}
          disabled={!knuckle}
          onChange={(e) => onKnuckle(parseFloat(e.target.value))}
        />
      </label>
      <Button
        className="sel-delete"
        title="Delete the selected point (Delete / Backspace)"
        disabled={!deletable}
        onClick={onDelete}
      >
        Delete
      </Button>
    </div>
  );
}

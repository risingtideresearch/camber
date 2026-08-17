import { Button } from "../components/Button";
import {
  canDelete,
  deleteCommand,
  hasKnuckle,
  knuckleCommand,
  labelFor,
  selArr,
} from "./selection";
import { useDocumentDispatch, useDocumentRuntime } from "./documentStoreHooks";
import { useEditorUi } from "./editorUi";
import "./SelectionInfo.css";

// The contextual selection readout: label, knuckle slider, delete — all derived from the current selection.
// The panel keeps constant height (the slider and delete are present but disabled when they don't apply) so
// selecting a point never reflows the app bar.

export function SelectionInfo() {
  const model = useDocumentRuntime();
  const dispatch = useDocumentDispatch();
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
  // The selected point may have stopped existing without this window touching anything: the selection is
  // window-local but the hull is shared, so another window's undo — or a jump in the history panel — can take
  // back the very insert that created it. So the point is resolved and its ABSENCE is a state, not a crash;
  // the readout simply falls back to "nothing to knuckle" until the selection is set again.
  const arr = selArr(model, selection);
  const point = selection && arr ? arr[selection.idx] : undefined;
  const knuckle = !!(selection && point && hasKnuckle(selection));
  const knuckleVal = point?.k ?? 0;
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

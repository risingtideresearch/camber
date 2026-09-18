import { NumberInput } from "polymorph-ui";
import { Button } from "../components/Button";
import { loa } from "../core/hull";
import {
  canDelete,
  deleteCommand,
  labelFor,
  selectionFields,
  type SelectionField,
} from "./selection";
import { useDocumentDispatch, useDocumentRuntime } from "./documentStoreHooks";
import { useEditorUi } from "./editorUi";
import "./SelectionInfo.css";

// The contextual selection readout: label, the selected point's values as editable fields, delete — all
// derived from the current selection. Which fields show depends on what is selected (see `selectionFields`),
// but the panel reserves room for the most there can be, so selecting a point never reflows the app bar.

// Shown rounded: a drag in a view leaves a full-precision float. 3 decimals for a coordinate, 2 for a knuckle
// (what its slider used to step by).
const shown = (f: SelectionField) => {
  const q = f.key === "k" ? 100 : 1000;
  return Math.round(f.value * q) / q;
};

export function SelectionInfo() {
  const model = useDocumentRuntime();
  const dispatch = useDocumentDispatch();
  const { selection, setSelection } = useEditorUi();
  // The selection is window-local and must never travel in a command, so it is resolved to one here.
  const onField = (f: SelectionField, v: number) => {
    const cmd = f.command(v);
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
  // the readout simply shows no fields until the selection is set again.
  const fields = selectionFields(model, selection);
  // Scrubbing an unbounded NumberInput moves it 1 per pixel, which is a leap in m and a crawl on a ship in
  // mm — so a coordinate is scrubbed at a step that follows the hull's length instead: 0.2 mm per pixel on a
  // 10 m hull. It is a fifth of a power of ten, so that scrubbing lands on round values in the document's
  // own unit (multiples of 0.2 in mm, of 0.0002 in m) rather than on multiples of whatever the length
  // happens to be.
  const step = 10 ** Math.round(Math.log10((loa(model) || 1) / 10000)) / 5;
  const deletable = !!selection && canDelete(model, selection);

  return (
    <div className="selinfo">
      <span className={"sel-label" + (selection ? "" : " muted")}>
        {selection ? labelFor(selection) : "No point selected"}
      </span>
      <div className="sel-fields">
        {fields.map((f) => (
          // NumberInput has no disabled state of its own, so a pinned value is made inert from outside
          <span
            key={f.key}
            className={"sel-field" + (f.disabled ? " disabled" : "")}
            title={f.title}
          >
            <span inert={f.disabled}>
              {f.min !== undefined && f.max !== undefined ? (
                <NumberInput
                  label={f.label}
                  value={shown(f)}
                  min={f.min}
                  max={f.max}
                  onChange={(v) => onField(f, v)}
                />
              ) : (
                <NumberInput
                  label={f.label}
                  value={shown(f)}
                  onChange={(v) => onField(f, v)}
                  onDragStart={(start) => ({ start })}
                  onDragMove={(v, { start }) =>
                    onField(f, start + (v - start) * step)
                  }
                />
              )}
            </span>
          </span>
        ))}
      </div>
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

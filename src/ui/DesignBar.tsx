// The right-aligned design actions: the editable name, the save-state text, and Save / Revert /
// Close. React-owned. A single Save button does both roles — it reads "Save" while the title still
// matches the saved design (overwrite) and flips to "Save As…" once the name is changed (insert a
// new row); the label + status text come from the controller via the dirty poll.
interface DesignBarProps {
  name: string;
  dirty: boolean; // amber edge on the name field while there are unsaved edits
  saveKind: "" | "dirty" | "saved";
  saveText: string;
  saveLabel: string; // "Save" | "Save As…"
  saving: boolean;
  onName: (name: string) => void;
  onNameBlur: () => void;
  onSave: () => void;
  onRevert: () => void;
  onClose: () => void;
}

export function DesignBar({
  name,
  dirty,
  saveKind,
  saveText,
  saveLabel,
  saving,
  onName,
  onNameBlur,
  onSave,
  onRevert,
  onClose,
}: DesignBarProps) {
  return (
    <div className="toolacts">
      <input
        id="docName"
        className={"docname" + (dirty ? " dirty" : "")}
        placeholder="Untitled"
        maxLength={120}
        title="Design name — edit to rename"
        spellCheck={false}
        value={name}
        onChange={(e) => onName(e.target.value)}
        onBlur={onNameBlur}
      />
      <span className={"savestate" + (saveKind ? " " + saveKind : "")} id="saveState">
        {saveText}
      </span>
      <button
        id="saveDesign"
        title="Save the design (Ctrl/Cmd-S) — becomes “Save As” when you change the name"
        onClick={onSave}
        disabled={saving}
      >
        {saveLabel}
      </button>
      <button id="revertDesign" title="Discard changes since the last save" onClick={onRevert}>
        Revert
      </button>
      <span className="tabsep" />
      <button id="toFiles" title="Close and return to the design library" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

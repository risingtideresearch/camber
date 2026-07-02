import { Button } from "../components/Button";
import { FilenameInput } from "../components/FilenameInput";
import "./DesignBar.css";

// The right-aligned design actions: the editable name, the save-state text, and Save / Revert /
// Close. React-owned. A single Save button does both roles — it reads "Save" while the title still
// matches the saved design (overwrite) and flips to "Save As…" once the name is changed (insert a
// new row); the label + status text come from EditorApp's save state (refreshed by the dirty poll).
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
      <FilenameInput
        value={name}
        placeholder="Untitled"
        title="Design name — edit to rename"
        dirty={dirty}
        onChange={onName}
        onBlur={onNameBlur}
      />
      <span className={"savestate" + (saveKind ? " " + saveKind : "")}>
        {saveText}
      </span>
      <Button
        title="Save the design (Ctrl/Cmd-S) — becomes “Save As” when you change the name"
        onClick={onSave}
        disabled={saving}
      >
        {saveLabel}
      </Button>
      <Button title="Discard changes since the last save" onClick={onRevert}>
        Revert
      </Button>
      <span className="tabsep" />
      <Button title="Close and return to the design library" onClick={onClose}>
        Close
      </Button>
    </div>
  );
}

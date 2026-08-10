import { useEditorUi } from "./editorUi";
import { Button } from "../components/Button";
import "./Toolbar.css";

// The edit-tool toolbar (Select / Add). React-owned: the active tool comes from state and each click sets it.

export function Toolbar() {
  const { tool, setTool: onTool } = useEditorUi();
  return (
    <div className="toolbar">
      <Button
        className="tool"
        active={tool === "select"}
        title="Select — click a point to select it, then drag to move, Delete to remove, or set its knuckle"
        onClick={() => onTool("select")}
      >
        <svg viewBox="0 0 16 16" fill="currentColor">
          <path d="M3 1.4l9.6 5.3-4.3.9-1 4.4z" />
        </svg>
        Select
      </Button>
      <Button
        className="tool"
        active={tool === "add"}
        title="Add — click empty space in an editor to add a control point there"
        onClick={() => onTool("add")}
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
          strokeLinecap="round"
        >
          <path d="M8 3v10M3 8h10" />
        </svg>
        Add
      </Button>
    </div>
  );
}

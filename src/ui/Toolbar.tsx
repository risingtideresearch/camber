// The edit-tool toolbar (Select / Add). Rendered as static markup with the exact ids/classes the
// imperative core expects: `interaction.ts`'s `initInteraction()` attaches the click handler to
// `#toolbar` and `setTool()` toggles the `.active` class. React renders these buttons once with
// constant props, so it never reconciles away those imperative class changes.
export function Toolbar() {
  return (
    <div className="toolbar" id="toolbar">
      <button
        className="tool active"
        data-tool="select"
        title="Select — click a point to select it, then drag to move, Delete to remove, or set its knuckle"
      >
        <svg viewBox="0 0 16 16" fill="currentColor">
          <path d="M3 1.4l9.6 5.3-4.3.9-1 4.4z" />
        </svg>
        Select
      </button>
      <button
        className="tool"
        data-tool="add"
        title="Add — click empty space in an editor to add a control point there"
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
      </button>
    </div>
  );
}

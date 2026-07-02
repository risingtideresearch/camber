// Entry point for the React editor.
//
// We deliberately do NOT wrap <EditorApp/> in <StrictMode>: boot runs exactly once (it loads the URL
// design and is guarded by a ref), and StrictMode's dev-only mount → unmount → remount would cancel that
// first boot and then skip the retry via the guard, leaving the editor unbooted.
import { createRoot } from "react-dom/client";
import { EditorApp } from "./editor/EditorApp";

const root = document.getElementById("root");
if (!root) throw new Error("editor: #root container not found");
createRoot(root).render(<EditorApp />);

// Entry point for the React editor.
//
// We deliberately do NOT wrap <EditorApp/> in <StrictMode>: the editor boots the imperative core
// exactly once (initInteraction() installs global pointer/keyboard listeners and boot() loads the
// design), and StrictMode double-invokes effects in development, which would double-bind those
// listeners and double-run boot(). The boot effect is additionally guarded by a ref.
//
// Note: this file imports only React + the component tree. The imperative core (and dom.ts, which
// resolves its element references at module-eval time) is pulled in lazily by EditorApp's boot
// effect, after React has committed the markup — so those references resolve against a live DOM.
import { createRoot } from "react-dom/client";
import { EditorApp } from "./editor/EditorApp";

const root = document.getElementById("root");
if (!root) throw new Error("editor: #root container not found");
createRoot(root).render(<EditorApp />);

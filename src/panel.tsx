// Entry point for a detached panel window — one panel of the editor, joined to the editor's session.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PanelApp } from "./editor/PanelApp";

const root = document.getElementById("root");
if (!root) throw new Error("panel: #root container not found");
createRoot(root).render(
  <StrictMode>
    <PanelApp />
  </StrictMode>,
);

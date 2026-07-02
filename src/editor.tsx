// Entry point for the React editor.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { EditorApp } from "./editor/EditorApp";

const root = document.getElementById("root");
if (!root) throw new Error("editor: #root container not found");
createRoot(root).render(
  <StrictMode>
    <EditorApp />
  </StrictMode>,
);

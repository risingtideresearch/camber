// Entry point for the React wave-pattern / fleet wake study.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MichellApp } from "./michell/MichellApp";

const root = document.getElementById("root");
if (!root) throw new Error("michell: #root container not found");
createRoot(root).render(
  <StrictMode>
    <MichellApp />
  </StrictMode>,
);

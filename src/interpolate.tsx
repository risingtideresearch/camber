// Entry point for the React interpolation viewer.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { InterpolateApp } from "./interpolate/InterpolateApp";

const root = document.getElementById("root");
if (!root) throw new Error("interpolate: #root container not found");
createRoot(root).render(
  <StrictMode>
    <InterpolateApp />
  </StrictMode>,
);

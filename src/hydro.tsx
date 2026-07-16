// Entry point for the React hydrostatics page.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HydroApp } from "./hydro/HydroApp";

const root = document.getElementById("root");
if (!root) throw new Error("hydro: #root container not found");
createRoot(root).render(
  <StrictMode>
    <HydroApp />
  </StrictMode>,
);

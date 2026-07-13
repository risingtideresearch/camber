// Entry point for the React hull performance viewer.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PerformanceApp } from "./performance/PerformanceApp";

const root = document.getElementById("root");
if (!root) throw new Error("performance: #root container not found");
createRoot(root).render(
  <StrictMode>
    <PerformanceApp />
  </StrictMode>,
);

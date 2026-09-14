import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { StlApp } from "./stl-workspace/StlApp";
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StlApp />
  </StrictMode>,
);

// Entry point for the React design library.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LibraryApp } from "./library/LibraryApp";

const root = document.getElementById("root");
if (!root) throw new Error("library: #root container not found");
createRoot(root).render(
  <StrictMode>
    <LibraryApp />
  </StrictMode>,
);

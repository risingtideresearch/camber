import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Multi-page app: three independent HTML entry points, each pulling in its own source module.
//   index.html       → src/files.ts   (design library)
//   editor.html      → src/editor.tsx (React editor)
//   interpolate.html → src/interp.ts  (hull interpolation viewer)
//
// base: "./" makes all emitted asset URLs relative, so the built site works whether it is served
// from a domain root or a GitHub Pages project subpath (…/camber/).
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    sourcemap: true,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        editor: resolve(import.meta.dirname, "editor.html"),
        interpolate: resolve(import.meta.dirname, "interpolate.html"),
      },
    },
  },
});

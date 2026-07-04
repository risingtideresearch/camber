import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Multi-page app. index.html is a bare redirect to the library (the home page); the other three HTML
// entry points each pull in their own source module.
//   index.html       → (redirect to library.html)
//   library.html     → src/library.tsx       (React design library)
//   editor.html      → src/editor.tsx        (React editor)
//   interpolate.html → src/interpolate.tsx   (React interpolation viewer)
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
        library: resolve(import.meta.dirname, "library.html"),
        editor: resolve(import.meta.dirname, "editor.html"),
        interpolate: resolve(import.meta.dirname, "interpolate.html"),
      },
    },
  },
});

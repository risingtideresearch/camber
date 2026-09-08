// Separate developer/test artifact, not the future standalone project application.
import { resolve } from "node:path";
import { defineConfig } from "vite";
export default defineConfig({
  root: resolve(import.meta.dirname, "../.."),
  base: "./",
  build: {
    outDir: "dist/mesh-spike",
    rollupOptions: {
      input: resolve(import.meta.dirname, "../../test/mesh-browser.html"),
    },
  },
});

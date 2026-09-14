// Independent static artifact; no Camber pages, Supabase or runtime environment required.
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  root: resolve(import.meta.dirname, "../.."),
  base: "./",
  plugins: [
    react(),
    {
      name: "analysis-home",
      enforce: "post",
      generateBundle(_options, bundle) {
        const page = bundle["analysis.html"];
        if (page?.type === "asset")
          this.emitFile({
            type: "asset",
            fileName: "index.html",
            source: page.source,
          });
      },
    },
  ],
  server: { open: "/analysis.html" },
  build: {
    outDir: "dist/analysis",
    rollupOptions: {
      input: resolve(import.meta.dirname, "../../analysis.html"),
    },
  },
});

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // GitHub Pages project site: https://horeattt.github.io/zenaios-data-collection/
  base: process.env.VITE_BASE || "/zenaios-data-collection/",
  plugins: [react()],
  server: {
    proxy: { "/api": "http://127.0.0.1:3000", "/fhir": "http://127.0.0.1:3000" }
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(rootDir, "index.html"),
        panou: resolve(rootDir, "panou.html")
      }
    }
  }
});

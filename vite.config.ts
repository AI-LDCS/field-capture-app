import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  resolve: { alias: { "@shared": path.resolve(import.meta.dirname, "shared") } },
  build: { outDir: "../dist/web", emptyOutDir: true },
});

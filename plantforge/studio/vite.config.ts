import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// The catalog and spec data live in the Python package (../plantforge) and are shared by both engines.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  server: { fs: { allow: [".."] } },
  build: { target: "es2022", chunkSizeWarningLimit: 4000 },
  test: { environment: "node" },
});

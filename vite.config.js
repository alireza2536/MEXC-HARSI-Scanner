import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: path.resolve(process.cwd(), "public"),
  base: "./",
  publicDir: false,
  build: {
    outDir: path.resolve(process.cwd(), "www"),
    emptyOutDir: true,
    sourcemap: false
  }
});

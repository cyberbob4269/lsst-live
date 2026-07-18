import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Standard Tauri + Vite settings: fixed dev port, no console clearing so
// tauri CLI output stays visible.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Don't watch the Rust side for changes.
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    outDir: "dist",
  },
});

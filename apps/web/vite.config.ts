import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Dev: /api is proxied to the Node API (:8080). Production: the API serves the built files.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, proxy: { "/api": { target: "http://127.0.0.1:8080", changeOrigin: true } } },
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 900 },
});

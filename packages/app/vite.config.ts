import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The web UI lives in src/web and builds to dist/web, which the server serves.
// In development Vite serves it and forwards /api to the server.
const api = process.env.POCKET_API ?? "http://127.0.0.1:6880";

export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
  server: {
    port: 5180,
    proxy: {
      "/api": { target: api, changeOrigin: false },
    },
  },
});

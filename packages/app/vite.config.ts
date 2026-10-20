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
    rolldownOptions: {
      output: {
        // Keep third-party code in its own files so a rebuild of our code doesn't
        // invalidate the browser cache for React and the markdown stack, and so no
        // single chunk crosses Vite's 500 kB warning limit.
        codeSplitting: {
          groups: [
            { name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 20 },
            { name: "vendor", test: /node_modules/, priority: 10 },
          ],
        },
      },
    },
  },
  server: {
    port: 5180,
    proxy: {
      "/api": { target: api, changeOrigin: false },
    },
  },
});

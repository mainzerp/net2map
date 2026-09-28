import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Prefer TypeScript sources over .js/.jsx on basename collisions
    // (defensive; the former Port.jsx/Port.tsx duplicate is removed).
    extensions: [".mjs", ".mts", ".ts", ".tsx", ".js", ".jsx", ".json"],
  },
  server: {
    port: 5173,
    proxy: {
      // During local dev, forward /api/* → backend
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
      // WebSocket endpoint (scan progress) needs the ws upgrade flag
      "/ws": {
        target: "http://localhost:8000",
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});

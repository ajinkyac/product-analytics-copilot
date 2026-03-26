import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/v1": {
        target: process.env["VITE_API_URL"] ?? "http://localhost:3001",
        changeOrigin: true,
      },
      "/ws": {
        target: process.env["VITE_API_URL"] ?? "http://localhost:3001",
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
          query: ["@tanstack/react-query"],
          recharts: ["recharts"],
          codemirror: ["codemirror", "@codemirror/lang-sql"],
        },
      },
    },
  },
});

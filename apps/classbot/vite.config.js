import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // The production admin is served by the existing Quilo server at
  // https://quilolab.com/schedule/. Keep assets and API calls inside that
  // namespace so they never collide with the report application's routes.
  base: "/schedule/",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/schedule/api": {
        target: "http://localhost:4310",
        rewrite: (path) => path.replace(/^\/schedule/, ""),
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});

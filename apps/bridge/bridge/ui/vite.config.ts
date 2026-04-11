import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 3200,
    proxy: {
      "/bridge-ws": {
        target: "ws://localhost:3100",
        ws: true,
      },
    },
  },
});

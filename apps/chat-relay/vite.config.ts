import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const serverPort = Number(process.env.RELAY_SERVER_PORT ?? 4400);
const clientPort = Number(process.env.RELAY_CLIENT_PORT ?? 4401);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: clientPort,
    strictPort: true,
    proxy: {
      "/relay-ws": {
        target: `http://localhost:${serverPort}`,
        ws: true,
      },
      "/api/relay": {
        target: `http://localhost:${serverPort}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist-client",
    emptyOutDir: true,
  },
});

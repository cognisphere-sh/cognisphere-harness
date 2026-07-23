import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const SERVER_URL = process.env.PI_SERVER_URL ?? "http://127.0.0.1:7331";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 7330,
    proxy: {
      "/api": SERVER_URL,
      "/admin": SERVER_URL,
      "/webhook": SERVER_URL,
    },
  },
  build: {
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          markdown: ["react-markdown", "remark-gfm"],
          radix: [
            "@radix-ui/react-dialog",
            "@radix-ui/react-dropdown-menu",
            "@radix-ui/react-label",
            "@radix-ui/react-separator",
            "@radix-ui/react-slot",
            "@radix-ui/react-tooltip",
          ],
        },
      },
    },
  },
});

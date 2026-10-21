import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The client is a plain React SPA bundled by Vite and served either by the
// Vite middleware (development, mounted inside server/index.js) or as static
// files from dist/client (production). There is no framework runtime.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // `public/` holds the vendored Monaco editor + logo; Vite copies it verbatim
  // into the build output so the server only ever serves one directory.
  publicDir: "public",
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    assetsDir: "assets",
    sourcemap: false,
    target: "es2022",
  },
  server: {
    // The real HTTP server is created in server/index.js and handed to Vite as
    // middleware, so this block only configures the shared port/host defaults.
    port: 3000,
    strictPort: true,
  },
  optimizeDeps: {
    include: ["react", "react-dom", "zustand", "socket.io-client"],
  },
});
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  cacheDir: ".vite-cache",
  server: {
    host: "127.0.0.1",
    watch: { ignored: ["**/exports/**", "**/.data/**", "**/dist-service/**"] },
    fs: { strict: true, allow: [process.cwd()] },
  },
  build: { target: "es2022" },
});

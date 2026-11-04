import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "PONDSENSE_");
  const apiTarget = env.PONDSENSE_DEV_API_TARGET || "http://localhost:5000";

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        "/api": { target: apiTarget, changeOrigin: true }
      }
    }
  };
});

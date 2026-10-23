import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const adminRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(adminRoot, "..");

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, projectRoot, ""), ...process.env };
  const envValue = (...keys: string[]) => keys.map((key) => env[key]).find(Boolean) ?? "";

  return {
    root: adminRoot,
    plugins: [react()],
    resolve: {
      alias: { "@": resolve(projectRoot, "src") },
    },
    define: {
      "process.env.NEXT_PUBLIC_FIREBASE_API_KEY": JSON.stringify(envValue("VITE_FIREBASE_API_KEY", "NEXT_PUBLIC_FIREBASE_API_KEY")),
      "process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN": JSON.stringify(envValue("VITE_FIREBASE_AUTH_DOMAIN", "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN")),
      "process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID": JSON.stringify(envValue("VITE_FIREBASE_PROJECT_ID", "NEXT_PUBLIC_FIREBASE_PROJECT_ID")),
      "process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET": JSON.stringify(envValue("VITE_FIREBASE_STORAGE_BUCKET", "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET")),
      "process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID": JSON.stringify(envValue("VITE_FIREBASE_MESSAGING_SENDER_ID", "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID")),
      "process.env.NEXT_PUBLIC_FIREBASE_APP_ID": JSON.stringify(envValue("VITE_FIREBASE_APP_ID", "NEXT_PUBLIC_FIREBASE_APP_ID")),
      "process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID": JSON.stringify(envValue("VITE_FIREBASE_MEASUREMENT_ID", "NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID")),
      "process.env.NEXT_PUBLIC_API_URL": JSON.stringify(envValue("VITE_API_BASE_URL", "NEXT_PUBLIC_API_URL")),
      "process.env.NEXT_PUBLIC_ADMIN_STATIC": JSON.stringify("true"),
      "process.env.NEXT_PUBLIC_CUSTOMER_URL": JSON.stringify(envValue("VITE_CUSTOMER_URL", "NEXT_PUBLIC_CUSTOMER_URL")),
    },
    css: { postcss: resolve(projectRoot, "postcss.config.mjs") },
    server: { fs: { allow: [projectRoot] } },
    build: {
      outDir: resolve(adminRoot, "dist"),
      emptyOutDir: true,
    },
  };
});
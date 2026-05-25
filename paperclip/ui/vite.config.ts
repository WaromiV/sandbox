import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(async ({ mode }) => {
  let watchOpts: Record<string, unknown> = {};
  if (mode !== "production") {
    try {
      const { createUiDevWatchOptions } = await import("./src/lib/vite-watch");
      watchOpts = createUiDevWatchOptions(process.cwd());
    } catch {
      // ui/src/ is stripped from the deployment tarball; safe to skip since
      // vite dev is never run from the deployed artifact.
    }
  }

  return {
    plugins: [react(), tailwindcss()],
    build: {
      minify: "esbuild",
    },
    esbuild:
      mode === "production"
        ? {
            drop: ["console", "debugger"],
            legalComments: "none",
          }
        : undefined,
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
        lexical: path.resolve(__dirname, "./node_modules/lexical/Lexical.mjs"),
      },
    },
    server: {
      port: 5173,
      watch: watchOpts,
      proxy: {
        "/api": {
          target: "http://localhost:3100",
          ws: true,
        },
      },
    },
  };
});

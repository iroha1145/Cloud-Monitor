import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig(({ command, mode }) => ({
  plugins: [react(), tailwindcss()],
  base: command === "serve" ? "/" : mode === "showcase" ? "./" : "/static/app/",
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    outDir: mode === "showcase" ? "dist-showcase" : "../frontend/app",
    emptyOutDir: true,
    modulePreload: {
      resolveDependencies(_filename, deps) {
        return deps.filter(
          (dep) =>
            !/InsightTrend|SecondaryViews|AppDialogs|ArchivePanel|liveline/.test(
              dep,
            ),
        );
      },
    },
    rolldownOptions: {
      input: {
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
        demo: fileURLToPath(new URL("./demo.html", import.meta.url)),
      },
      output: {
        manualChunks(id: string) {
          if (id.includes("node_modules/liveline")) return "liveline";
          if (id.includes("node_modules/motion")) return "motion";
          if (id.includes("node_modules/lucide-react")) return "icons";
          if (id.includes("node_modules")) return "vendor";
        },
      },
    },
  },
  server: {
    watch: { usePolling: true, interval: 500, ignored: ["**/dist-showcase/**", "**/frontend/app/**", "**/evidence/**"] },
    proxy: { "/api": { target: process.env.CM_DEV_API || "https://token.openweb-ui.xyz", changeOrigin: true, secure: true } },
  },
}));

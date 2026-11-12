import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

/** Every screen draws its figures and Latin labels with this one face, but
 * the browser only learns of the file after the stylesheet has arrived.
 * A preload in the built page starts the download alongside the stylesheet.
 * The other subsets and Geist Mono stay on demand. */
function preloadFont(name: string): Plugin {
  let base = "/";
  return {
    name: "cm-preload-font",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: "post",
      handler(_html, { bundle }) {
        return Object.values(bundle ?? {})
          .filter((file) => file.type === "asset" && file.fileName.includes(name) && file.fileName.endsWith(".woff2"))
          .map((file) => ({
            tag: "link",
            // Fonts are fetched in CORS mode even from the same origin; a
            // preload without crossorigin would be downloaded twice.
            attrs: { rel: "preload", as: "font", type: "font/woff2", href: base + file.fileName, crossorigin: true },
            injectTo: "head" as const,
          }));
      },
    },
  };
}

export default defineConfig(({ command, mode }) => ({
  plugins: [react(), tailwindcss(), preloadFont("geist-latin-wght-normal")],
  base: command === "serve" ? "/" : mode === "showcase" ? "./" : "/static/app/",
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    outDir: mode === "showcase" ? "dist-showcase" : "../frontend/app",
    emptyOutDir: true,
    modulePreload: {
      resolveDependencies(_filename, deps) {
        return deps.filter(
          (dep) =>
            !/SecondaryViews|AppDialogs|ArchivePanel/.test(dep),
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
          // Leave liveline unassigned so it stays a lazy chunk: naming it
          // makes the bundler hoist it into the entry's static imports.
          if (id.includes("node_modules/liveline")) return;
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

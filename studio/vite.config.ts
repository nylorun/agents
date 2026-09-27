import { fileURLToPath, URL } from "node:url";
import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  root: "web",
  // Served at the root of the Studio server's origin.
  base: "/",
  define: {
    STUDIO_VERSION: JSON.stringify(pkg.version),
  },
  plugins: [react(), tailwindcss(), {
    name: "exclude-harness-run",
    moduleParsed(info) {
      if (/[/\\](?:harness|runtime|cli)[/\\](?:dist|src)[/\\]/.test(info.id) || /agents[/\\](?:dist|src)[/\\](?:executor|execute-action)\./.test(info.id)) {
        this.error("Studio must not bundle harness execution modules: " + info.id);
      }
    },
  }],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./web/src", import.meta.url)) }
  },
  server: {
    fs: {
      allow: [fileURLToPath(new URL(".", import.meta.url))],
    },
  },
  build: {
    outDir: "../dist/web",
    emptyOutDir: false
  }
});

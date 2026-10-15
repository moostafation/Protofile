import { defineConfig, Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// The desktop program (../desktop) loads the same page from disk: no web fonts, nothing from the network.
// The UI uses the system fonts (Segoe UI, Consolas); IBM Plex Mono is bundled for computers without Consolas.
const PLEX = "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin";
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob:",
  "worker-src 'self' blob:",
].join("; ");

function desktopPage(desktop: boolean): Plugin {
  return {
    name: "plantforge-desktop-page",
    resolveId: (id) => (id === "virtual:offline-fonts" ? "\0virtual:offline-fonts" : null),
    load(id) {
      if (id !== "\0virtual:offline-fonts") return null;
      if (!desktop) return "export {};";
      return [
        `import w400 from "${PLEX}-400-normal.woff2";`,
        `import w500 from "${PLEX}-500-normal.woff2";`,
        "const face = (w, url) => `@font-face{font-family:'IBM Plex Mono';font-style:normal;font-weight:${w};font-display:swap;src:url(${url}) format('woff2')}`;",
        "const style = document.createElement('style');",
        "style.textContent = face(400, w400) + face(500, w500);",
        "document.head.appendChild(style);",
      ].join("\n");
    },
    transformIndexHtml(html) {
      if (!desktop) return html;
      return html
        .replace(/\s*<link[^>]+fonts\.(googleapis|gstatic)\.com[^>]*>/g, "")
        .replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
    },
  };
}

// The catalog and spec data live in the Python package (../plantforge) and are shared by both engines.
export default defineConfig(({ mode }) => {
  const desktop = mode === "desktop";
  return {
    plugins: [react(), viteSingleFile(), desktopPage(desktop)],
    server: { fs: { allow: [".."] } },
    build: desktop ? { target: "chrome120", chunkSizeWarningLimit: 4000, outDir: "../desktop/app", emptyOutDir: true } : { target: "es2022", chunkSizeWarningLimit: 4000 },
    test: { environment: "node" },
  };
});

// Turn the single-file build (dist/index.html) into:
//   dist/plantforge-studio.html  - standalone page (open directly in a browser)
//   dist/artifact.html           - page content without the document wrapper (for claude.ai artifacts)
import { readFileSync, writeFileSync } from "node:fs";

const html = readFileSync("dist/index.html", "utf8");
writeFileSync("dist/plantforge-studio.html", html);

const take = (re) => [...html.matchAll(re)].map((m) => m[0]);
const title = take(/<title>[\s\S]*?<\/title>/g)[0] ?? "<title>PlantForge Studio</title>";
const links = take(/<link [^>]*>/g).join("\n");
const styles = take(/<style[^>]*>[\s\S]*?<\/style>/g).join("\n");
const scripts = take(/<script[^>]*>[\s\S]*?<\/script>/g).join("\n");
const fragment = `${title}\n${links}\n${styles}\n<div id="root"></div>\n${scripts}\n`;
writeFileSync("dist/artifact.html", fragment);
console.log(`artifact.html ${(fragment.length / 1024).toFixed(0)} KB`);

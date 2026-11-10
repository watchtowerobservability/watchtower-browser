import { readFileSync } from "node:fs";
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
// The core imports its lazy chunks statically (bundlers can then split them); they stay external
// here and resolve to the sibling files esbuild writes below.
export const chunkPaths = { "./replay/index.js": "./replay.js", "./assist.js": "./assist.js", "./probes.js": "./probes.js", "./feedback.js": "./feedback.js", "./instrument/index.js": "./instrument/index.js", "./load-url.js": "./load-url.js" };
export const lazyChunks = { name: "lazy-chunks", setup(b) { b.onResolve({ filter: /^\.\/(replay\/index|assist|probes|feedback|instrument\/index|load-url)\.js$/ }, (a) => (a.importer.endsWith("src/index.ts") ? { path: chunkPaths[a.path], external: true } : undefined)); } };
export const define = { __WT_VERSION__: JSON.stringify(version) };

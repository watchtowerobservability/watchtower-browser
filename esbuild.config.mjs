import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { buildManifest } from "./manifest.mjs";
import { define, lazyChunks, liteChunks } from "./esbuild.shared.mjs";
import { readFileSync } from "node:fs";
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
// Hashed chunks change name every build: without this, stale ones from older builds pile up in dist/ and get published.
rmSync("dist", { recursive: true, force: true });
const common = { entryPoints: ["src/index.ts"], bundle: true, minify: true, target: "es2020", sourcemap: true, define: { ...define, __WT_IIFE__: "false" } };
await build({ ...common, format: "esm", plugins: [lazyChunks], outfile: "dist/index.js" });
// iife has no import.meta: lazy chunks resolve next to the script tag that loaded wt.min.js.
await build({ ...common, format: "iife", plugins: [lazyChunks], banner: { js: "var __wtUrl=(document.currentScript&&document.currentScript.src)||location.href;" }, define: { ...define, __WT_IIFE__: "true", "import.meta.url": "__wtUrl" }, globalName: "Watchtower", outfile: "dist/wt.min.js" });
// `/lite` entry: init without the replay, assist, feedback and probes chunk references (single-file builds).
await build({ ...common, entryPoints: ["src/lite.ts"], format: "esm", plugins: [liteChunks, lazyChunks], outfile: "dist/lite.js" });
// `/beacon` entry: ~1.5 KB RUM beacon (vitals + errors, one sendBeacon), ESM and a script-tag IIFE.
await build({ ...common, entryPoints: ["src/beacon.ts"], format: "esm", outfile: "dist/beacon.js" });
await build({ ...common, entryPoints: ["src/beacon.ts"], format: "iife", globalName: "WatchtowerBeacon", sourcemap: false, outfile: "dist/beacon.min.js" });
// Lazy replay chunk (rrweb record + fflate), loaded on demand by the core via `replay.scriptUrl`.
await build({ ...common, entryPoints: ["src/replay/index.ts"], format: "esm", outfile: "dist/replay.js" });
// Lazy co-browse assist chunk (RPL-012), loaded only with `assist.enabled`.
await build({ ...common, entryPoints: ["src/assist.ts"], format: "esm", outfile: "dist/assist.js" });
// Lazy dynamic-probes chunk (P6-DI1), loaded only when `probes.key` is configured.
await build({ ...common, entryPoints: ["src/probes.ts"], format: "esm", outfile: "dist/probes.js" });
// Lazy user-feedback chunk (ERR-014), loaded on the first `feedback` or `feedbackWidget` call.
await build({ ...common, entryPoints: ["src/feedback.ts"], format: "esm", outfile: "dist/feedback.js" });
// `/storage` entry: sql.js / wa-sqlite wrappers, imported by apps that use them (never by the core).
await build({ ...common, entryPoints: ["src/storage.ts"], format: "esm", outfile: "dist/storage.js" });
// `/consent` entry: Cookie Munch bridge (types only from the core, no runtime import).
await build({ ...common, entryPoints: ["src/consent.ts"], format: "esm", outfile: "dist/consent.js" });
// Lazy instrumentation chunk (errors, frustration, resources, ...). OTel tracing and web-vitals are
// split into their own files by the dynamic imports, so the eager part stays small.
await build({ ...common, entryPoints: ["src/instrument/index.ts"], format: "esm", splitting: true, outdir: "dist/instrument" });
// Framework adapters (react stays an external peer) and Node build plugins.
await build({ ...common, entryPoints: ["src/adapters/react.tsx", "src/adapters/next.ts", "src/adapters/vue.ts", "src/adapters/angular.ts", "src/adapters/svelte.ts"], format: "esm", splitting: true, external: ["react"], outdir: "dist/adapters" });
await build({ ...common, entryPoints: ["plugins/vite.ts", "plugins/rollup.ts", "plugins/webpack.ts"], platform: "node", format: "esm", splitting: true, outdir: "dist/plugins" });
// Written verbatim, not minified: the bundler hints must survive (see src/load-url.ts).
mkdirSync("dist", { recursive: true });
writeFileSync("dist/load-url.js", "export const loadUrl = (u) => import(/* webpackIgnore: true */ /* @vite-ignore */ u);\n");
copyFileSync("src/storage-declaration.json", "dist/storage.json");
// Last, over the real output, so it cannot drift.
writeFileSync("dist/manifest.json", JSON.stringify(buildManifest("dist", version), null, 2) + "\n");

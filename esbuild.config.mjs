import { build } from "esbuild";

const common = { entryPoints: ["src/index.ts"], bundle: true, minify: true, target: "es2020", sourcemap: true };
await build({ ...common, format: "esm", outfile: "dist/index.js" });
await build({ ...common, format: "iife", globalName: "Watchtower", outfile: "dist/wt.min.js" });
// Lazy replay chunk (rrweb record + fflate), loaded on demand by the core via `replay.scriptUrl`.
await build({ ...common, entryPoints: ["src/replay/index.ts"], format: "esm", outfile: "dist/replay.js" });
// Lazy dynamic-probes chunk (P6-DI1), loaded only when `probes.key` is configured.
await build({ ...common, entryPoints: ["src/probes.ts"], format: "esm", outfile: "dist/probes.js" });
// Lazy instrumentation chunk (errors, frustration, resources, ...). OTel tracing and web-vitals are
// split into their own files by the dynamic imports, so the eager part stays small.
await build({ ...common, entryPoints: ["src/instrument/index.ts"], format: "esm", splitting: true, outdir: "dist/instrument" });
// Framework adapters (react stays an external peer) and Node build plugins.
await build({ ...common, entryPoints: ["src/adapters/react.tsx", "src/adapters/next.ts", "src/adapters/vue.ts", "src/adapters/angular.ts", "src/adapters/svelte.ts"], format: "esm", splitting: true, external: ["react"], outdir: "dist/adapters" });
await build({ ...common, entryPoints: ["plugins/vite.ts", "plugins/rollup.ts", "plugins/webpack.ts"], platform: "node", format: "esm", splitting: true, outdir: "dist/plugins" });

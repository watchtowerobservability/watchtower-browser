import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { expect, it } from "vitest";

/** Eager core budget. The whole RUM bundle (core + instrumentation) has its own budget below. */
export const CORE_BUDGET_GZ = 12 * 1024;
export const RUM_BUDGET_GZ = 35 * 1024;

it("size_budget_core_under_12kib_gz", async () => {
  const r = await build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    minify: true,
    format: "iife",
    target: "es2020",
    write: false,
  });
  const gz = gzipSync(r.outputFiles[0]!.contents).length;
  expect(gz).toBeLessThan(CORE_BUDGET_GZ);
});

it("rum_bundle_under_35kib_gz", async () => {
  const r = await build({
    entryPoints: ["src/index.ts", "src/instrument/index.ts"],
    bundle: true,
    minify: true,
    format: "esm",
    splitting: true,
    outdir: "out",
    target: "es2020",
    write: false,
    metafile: true,
  });
  // OTel and web-vitals are lazy chunks, excluded from the budget by the spec.
  const heavy = /node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?(@opentelemetry|web-vitals)/;
  const outputs = Object.entries(r.metafile.outputs);
  let total = 0;
  for (const f of r.outputFiles) {
    const meta = outputs.find(([name]) => f.path.endsWith(name.replace(/^out\//, "")));
    if (!meta || meta[0].endsWith(".map")) continue;
    if (Object.keys(meta[1].inputs).some((i) => heavy.test(i))) continue;
    total += gzipSync(f.contents).length;
  }
  expect(total).toBeLessThan(RUM_BUDGET_GZ);
});

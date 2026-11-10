import { defineConfig } from "vitest/config";

import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  define: { __WT_VERSION__: JSON.stringify(pkg.version), __WT_IIFE__: "false" },
  test: { environment: "happy-dom", setupFiles: ["vitest.setup.ts"], include: ["src/**/*.test.ts", "plugins/**/*.test.ts"] },
});

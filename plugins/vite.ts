import { watchtowerRollup } from "./rollup.js";
import type { UploadOptions } from "./upload.js";

/** Vite: `plugins: [watchtower({ api, project })]` with `build.sourcemap: true` (or "hidden"). */
export function watchtower(o: UploadOptions) {
  return { ...watchtowerRollup(o), apply: "build" as const };
}
export type { UploadOptions };

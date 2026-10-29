import { watchtowerRollup } from "./rollup";
import type { UploadOptions } from "./upload";

/** Vite: `plugins: [watchtower({ api, project })]` with `build.sourcemap: true` (or "hidden"). */
export function watchtower(o: UploadOptions) {
  return { ...watchtowerRollup(o), apply: "build" as const };
}
export type { UploadOptions };

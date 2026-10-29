import { injectDebugId } from "./debugid";
import { uploadMaps, type UploadOptions } from "./upload";

type Bundle = Record<string, { type: string; code?: string; source?: string | Uint8Array }>;

/** Rollup/Vite output plugin: injects debug ids in `generateBundle`, uploads maps in `writeBundle`. */
export function watchtowerRollup(o: UploadOptions) {
  return {
    name: "watchtower-sourcemaps",
    generateBundle(_opts: unknown, bundle: Bundle): void {
      for (const [file, chunk] of Object.entries(bundle)) {
        if (chunk.type !== "chunk" || chunk.code === undefined) continue;
        const mapAsset = bundle[`${file}.map`];
        const r = injectDebugId(file, chunk.code, mapAsset ? String(mapAsset.source) : undefined);
        chunk.code = r.js;
        if (mapAsset && r.map) mapAsset.source = r.map;
      }
    },
    async writeBundle(opts: { dir?: string }, bundle: Bundle): Promise<void> {
      const dir = opts.dir ?? ".";
      const maps = Object.keys(bundle).filter((f) => f.endsWith(".map")).map((f): [string, string] => [f, `${dir}/${f}`]);
      await uploadMaps(o, maps);
    },
  };
}

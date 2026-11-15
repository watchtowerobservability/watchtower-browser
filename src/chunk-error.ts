const seen = new Set<string>();

/** One clear console error per failed lazy chunk (404, or an SPA fallback serving HTML), then rethrow for the caller's own catch. */
export function chunkFailed(file: string, base: string, err: unknown): never {
  if (!seen.has(file)) {
    seen.add(file);
    try {
      console.error(`[watchtower] could not load chunk "${file}" (base URL ${base}). Serve every file listed in manifest.json next to wt.min.js, and make sure unknown paths return 404, not your app's index.html. ${String(err)}`);
    } catch {
      /* no console */
    }
  }
  throw err;
}

/** Test hook: forget which chunks were already reported. */
export const resetChunkErrors = (): void => seen.clear();

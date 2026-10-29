import { execSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { gzipSync } from "node:zlib";

export interface UploadOptions {
  api: string;
  project: string;
  /** Defaults to `$WT_API_KEY`. Must be a secret key; publishable keys (`wtp_`) are refused. */
  apiKey?: string;
  release?: string;
  /** Default true. */
  deleteSourcemapsAfterUpload?: boolean;
  failOnError?: boolean;
  fetch?: typeof fetch;
}

export function resolveRelease(o: UploadOptions): string {
  if (o.release) return o.release;
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** Same request shape as `wtctl sourcemaps upload`. `maps` are [release-relative name, file path]. */
export async function uploadMaps(o: UploadOptions, maps: Array<[string, string]>): Promise<void> {
  const key = o.apiKey ?? process.env.WT_API_KEY ?? "";
  if (!key) throw new Error("watchtower: WT_API_KEY (secret API key) is required to upload source maps");
  if (key.startsWith("wtp_")) throw new Error("watchtower: refusing to upload with a publishable key; use a secret API key");
  const f = o.fetch ?? fetch;
  const release = resolveRelease(o);
  const errors: string[] = [];
  for (const [name, path] of maps) {
    try {
      const q = new URLSearchParams({ kind: "sourcemap", name });
      if (release) q.set("release", release);
      const res = await f(`${o.api.replace(/\/+$/, "")}/v1/projects/${encodeURIComponent(o.project)}/artifacts?${q}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/octet-stream", "Content-Encoding": "gzip" },
        body: gzipSync(await readFile(path)),
      });
      if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
      if (o.deleteSourcemapsAfterUpload !== false) await rm(path, { force: true });
    } catch (e) {
      errors.push(String(e));
    }
  }
  if (errors.length && o.failOnError) throw new Error(`watchtower source map upload failed: ${errors.join("; ")}`);
  for (const e of errors) console.warn("[watchtower]", e);
}

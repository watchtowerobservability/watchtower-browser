import { execSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { gzipSync } from "node:zlib";

export interface UploadOptions {
  api: string;
  project: string;
  /** Defaults to `$WT_API_KEY`. Must be a secret key; publishable keys (`wtp_`) are refused. */
  apiKey?: string;
  /** Defaults to `$WT_RELEASE`, else the short sha (`git rev-parse --short HEAD`), matching deploy markers and `service.version`. */
  release?: string;
  /** Default true. */
  deleteSourcemapsAfterUpload?: boolean;
  /** Default false: a failed upload logs a warning and the build passes. Set true to fail the build. For maps written by later build steps, run `wtctl sourcemaps upload` instead. */
  failOnError?: boolean;
  /** Base delay of the exponential retry backoff in ms (default 500; up to 4 retries on 429, 5xx and network errors, `Retry-After` honoured, capped at 30 s). */
  retryDelayMs?: number;
  fetch?: typeof fetch;
}

export function resolveRelease(o: UploadOptions): string {
  if (o.release) return o.release;
  if (process.env.WT_RELEASE) return process.env.WT_RELEASE;
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fetch with up to 4 retries on 429/5xx/network errors: exponential backoff, `Retry-After` (seconds) wins. */
async function withRetry(o: UploadOptions, send: () => Promise<Response>): Promise<Response> {
  const base = o.retryDelayMs ?? 500;
  for (let i = 0; ; i++) {
    let res: Response | undefined;
    let err: unknown;
    try {
      res = await send();
    } catch (e) {
      err = e;
    }
    if (res && res.status !== 429 && res.status < 500) return res;
    if (i >= 4) {
      if (res) return res;
      throw err;
    }
    const ra = Number(res?.headers.get("retry-after"));
    await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30_000) : base * 2 ** i);
  }
}

/** Same request shape as `wtctl sourcemaps upload`. `maps` are [release-relative name, file path]. */
export async function uploadMaps(o: UploadOptions, maps: Array<[string, string]>): Promise<void> {
  const key = o.apiKey ?? process.env.WT_API_KEY ?? "";
  if (!key) throw new Error("watchtower: WT_API_KEY (secret API key) is required to upload source maps");
  if (key.startsWith("wtp_")) throw new Error("watchtower: refusing to upload with a publishable key; use a secret API key");
  const f = o.fetch ?? fetch;
  const release = resolveRelease(o);
  const base = `${o.api.replace(/\/+$/, "")}/v1/projects/${encodeURIComponent(o.project)}`;
  const auth = { Authorization: `Bearer ${key}` };
  const errors: string[] = [];
  if (release && maps.length) {
    // POST /releases is idempotent (201 new, 200 existing); artifacts are refused for an unknown release.
    try {
      const res = await withRetry(o, () => f(`${base}/releases`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ version: release }),
      }));
      if (!res.ok) throw new Error(`release ${release}: HTTP ${res.status}`);
    } catch (e) {
      maps = [];
      errors.push(String(e));
    }
  }
  // Bounded concurrency: 4 workers pull from a shared queue.
  const queue = [...maps];
  const upload = async ([name, path]: [string, string]): Promise<void> => {
    try {
      const q = new URLSearchParams({ kind: "sourcemap", name });
      if (release) q.set("release", release);
      const body = new Uint8Array(gzipSync(await readFile(path)));
      const res = await withRetry(o, () =>
        f(`${base}/artifacts?${q}`, {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/octet-stream", "Content-Encoding": "gzip" },
          body,
        }),
      );
      if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
      if (o.deleteSourcemapsAfterUpload !== false) await rm(path, { force: true });
    } catch (e) {
      errors.push(String(e));
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => { for (let m; (m = queue.shift()); ) await upload(m); }));
  if (errors.length && o.failOnError) throw new Error(`watchtower source map upload failed: ${errors.join("; ")}`);
  for (const e of errors) console.warn("[watchtower]", e);
}

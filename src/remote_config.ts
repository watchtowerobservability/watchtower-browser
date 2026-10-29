import { DEFAULT_REMOTE, LIMITS, type RemoteConfig } from "./config";

/** Fetch `/v1/rum/config` with a 2 s timeout; any failure yields the safe defaults (RUM on, replay off). */
export async function fetchRemoteConfig(
  endpoint: string,
  key: string,
  f: typeof fetch = globalThis.fetch?.bind(globalThis),
): Promise<RemoteConfig> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), LIMITS.configTimeoutMs);
  try {
    const r = await f(`${endpoint.replace(/\/$/, "")}/v1/rum/config`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: ctl.signal,
    });
    if (!r.ok) return DEFAULT_REMOTE;
    const j = (await r.json()) as Partial<RemoteConfig>;
    return { ...DEFAULT_REMOTE, ...j, replay: { enabled: j.replay?.enabled === true, ...maskLevel(j.replay) } };
  } catch {
    return DEFAULT_REMOTE;
  } finally {
    clearTimeout(timer);
  }
}

type Level = "strict" | "balanced" | "relaxed";
const LEVELS: ReadonlySet<string> = new Set<Level>(["strict", "balanced", "relaxed"]);
/** Keep the server's mask floor only when it is a known level; anything else is dropped (the local strict default applies). */
const maskLevel = (r: unknown): { mask_level?: Level } => {
  const l = (r as { mask_level?: unknown } | undefined)?.mask_level;
  return typeof l === "string" && LEVELS.has(l) ? { mask_level: l as Level } : {};
};

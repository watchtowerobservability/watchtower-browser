import { REPLAY_LIMITS, type ReplayPlugin } from "./config";

const ALWAYS_DROP = /^(authorization|cookie|set-cookie)$/i;
type Level = "log" | "info" | "warn" | "error";

export function consolePlugin(levels: Level[] = ["log", "info", "warn", "error"]): ReplayPlugin {
  return {
    name: "console",
    start(emit) {
      const orig = new Map<Level, (...a: unknown[]) => void>();
      for (const l of levels) {
        const o = console[l].bind(console);
        orig.set(l, o);
        console[l] = (...a: unknown[]): void => {
          try {
            emit({ level: l, args: a.map((x) => String(x).slice(0, 500)).slice(0, 10) });
          } catch {
            /* never break the host */
          }
          o(...a);
        };
      }
      return () => {
        for (const [l, o] of orig) console[l] = o;
      };
    },
  };
}

/** Query values are replaced by `*`; the fragment is dropped. */
export function scrubUrl(u: string): string {
  try {
    const x = new URL(u, location.href);
    const q = [...x.searchParams.keys()].map((k) => `${encodeURIComponent(k)}=*`).join("&");
    return x.origin + x.pathname + (q ? `?${q}` : "");
  } catch {
    return "[invalid]";
  }
}

export interface NetworkOpts {
  /** only these URLs are recorded */
  urls: (string | RegExp)[];
  /** response header names to keep; `authorization`, `cookie` and `set-cookie` are always dropped */
  captureHeaders?: string[];
  /** request header names to keep (allow-list; none by default) */
  captureRequestHeaders?: string[];
  /**
   * Body capture, off unless set. JSON bodies keep their shape but every value is `*` except the
   * keys in `allowKeys`; non-JSON bodies record only their size. Capped at `maxBytes` (default 4096).
   */
  bodies?: { allowKeys?: string[]; maxBytes?: number };
}

/** Masks every leaf value of a JSON body except allow-listed keys; anything else becomes a size marker. */
export function maskBody(text: string, allowKeys: string[] = [], maxBytes = 4096): unknown {
  if (text.length > maxBytes) return { truncated: true, bytes: text.length };
  const allow = new Set(allowKeys.map((k) => k.toLowerCase()));
  const walk = (v: unknown, keep: boolean): unknown => {
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => walk(x, keep));
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, allow.has(k.toLowerCase()))]));
    }
    return keep ? v : "*";
  };
  try {
    return walk(JSON.parse(text), false);
  } catch {
    return { masked_bytes: text.length };
  }
}

/** Records method, scrubbed URL, status and duration of fetch calls. Bodies only when `bodies` is set, and masked. */
export function networkPlugin(o: NetworkOpts): ReplayPlugin {
  const want = (u: string): boolean => o.urls.some((m) => (typeof m === "string" ? u.includes(m) : m.test(u)));
  const names = (o.captureHeaders ?? []).filter((n) => !ALWAYS_DROP.test(n));
  const reqNames = (o.captureRequestHeaders ?? []).filter((n) => !ALWAYS_DROP.test(n));
  return {
    name: "network",
    start(emit) {
      const orig = globalThis.fetch;
      if (!orig) return () => undefined;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const t0 = performance.now();
        const rec = (status: number, res?: Response, resBody?: string): void => {
          if (!want(url)) return;
          const reqHeaders: Record<string, string> = {};
          const h = new Headers(init?.headers ?? (typeof input === "object" && "headers" in input ? input.headers : undefined));
          for (const n of reqNames) {
            const v = h.get(n);
            if (v != null) reqHeaders[n.toLowerCase()] = v;
          }
          const b = o.bodies;
          const reqBody = b && typeof init?.body === "string" ? maskBody(init.body, b.allowKeys, b.maxBytes) : undefined;
          const resMasked = b && resBody !== undefined ? maskBody(resBody, b.allowKeys, b.maxBytes) : undefined;
          const headers: Record<string, string> = {};
          for (const n of names) {
            const v = res?.headers.get(n);
            if (v != null) headers[n.toLowerCase()] = v;
          }
          emit({
            method: (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase(),
            url: scrubUrl(url),
            status,
            duration_ms: Math.round(performance.now() - t0),
            ...(names.length ? { headers } : {}),
            ...(reqNames.length ? { request_headers: reqHeaders } : {}),
            ...(reqBody === undefined ? {} : { request_body: reqBody }),
            ...(resMasked === undefined ? {} : { response_body: resMasked }),
          });
        };
        try {
          const res = await orig(input, init);
          let text: string | undefined;
          if (o.bodies && want(url)) text = await res.clone().text().catch(() => undefined);
          rec(res.status, res, text);
          return res;
        } catch (e) {
          rec(0);
          throw e;
        }
      };
      return () => void (globalThis.fetch = orig);
    },
  };
}

export interface StateOpts<S> {
  name: string;
  getState: () => S;
  serialize?: (s: S) => unknown;
  intervalMs?: number;
}

/** Periodic app-state snapshots (e.g. redux). Off unless added; each snapshot is capped at 32 KiB. */
export function statePlugin<S>(o: StateOpts<S>): ReplayPlugin {
  return {
    name: `state:${o.name}`,
    start(emit) {
      const snap = (): void => {
        try {
          const json = JSON.stringify((o.serialize ?? ((s: S) => s))(o.getState()));
          emit(json.length > REPLAY_LIMITS.stateMaxBytes ? { truncated: true, bytes: json.length } : { state: JSON.parse(json) });
        } catch {
          /* unserializable state is skipped */
        }
      };
      snap();
      const t = setInterval(snap, o.intervalMs ?? 5000);
      return () => clearInterval(t);
    },
  };
}

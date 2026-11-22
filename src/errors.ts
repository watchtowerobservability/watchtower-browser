// Consent-free, storage-free error capture: no cookies, no localStorage, no session or user id, nothing queued.
// Each error is one simple cross-origin POST (text/plain, key in `?k=`: no preflight) to /v1/rum/events.
// When the full client starts it calls `handoff()` on the global below: this entry removes its listeners and
// forwards later `captureError` calls to the full client, so errors are never reported twice.
export interface ErrorsOptions {
  endpoint: string;
  publishableKey: string;
  release?: string;
  environment?: string;
  service?: string;
  /** Errors sent per page load (default 50). */
  maxEvents?: number;
}

const V8 = /^\s*at (?:async )?(?:(.*?) \()?(.+?):(\d+):(\d+)\)?\s*$/;
const GECKO = /^\s*(.*?)@(.+?):(\d+):(\d+)\s*$/;
const KEY = Symbol.for("watchtower.errors");
const uuid = (): string => (([1e7] as unknown as string) + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) => ((+c ^ (Math.random() * 16) >> (+c / 4)) as number).toString(16));
const bare = (u: string): string => u.split(/[?#]/)[0]!;

let send: ((e: unknown, mechanism: string, handled: boolean) => void) | undefined;
let forward: ((e: unknown) => void) | undefined;

/** Report a handled error. Forwards to the full client once it has taken over. */
export function captureError(err: unknown): void {
  if (forward) forward(err);
  else send?.(err, "manual", true);
}

export function initErrors(o: ErrorsOptions): void {
  if (send || typeof window === "undefined") return;
  const url = `${o.endpoint.replace(/\/$/, "")}/v1/rum/events?k=${encodeURIComponent(o.publishableKey)}`;
  const seen = new Set<string>();
  let n = 0;
  send = (err, mechanism, handled) => {
    try {
      const e = (typeof err === "object" && err ? err : { message: String(err) }) as { name?: string; message?: unknown; stack?: unknown };
      const message = String(e.message ?? "").slice(0, 1024);
      const stack = typeof e.stack === "string" ? e.stack : "";
      const key = `${message}|${stack}`;
      if (n >= (o.maxEvents ?? 50) || seen.has(key)) return;
      seen.add(key);
      n++;
      const frames = stack.split("\n").flatMap((l) => {
        const m = V8.exec(l) ?? GECKO.exec(l);
        return m ? [{ function: m[1] || "?", filename: bare(m[2]!), lineno: +m[3]!, colno: +m[4]! }] : [];
      }).slice(0, 50).reverse();
      const page = bare(location.href);
      const type = e.name || "Error";
      const ts_ns = Date.now() * 1e6;
      const body = JSON.stringify({
        session_id: uuid(), // fresh per event, never stored: it correlates nothing
        sent_at_ns: ts_ns,
        sdk: { name: "@watchtowerobservability/browser/errors", version: "errors" },
        app: { service: o.service || "web", release: o.release, env: o.environment },
        page: { url: page },
        device: { ua: navigator.userAgent },
        user: {},
        attrs: {},
        events: [{ id: uuid(), ts_ns, type: "error", name: type, attrs: { type, message, stack: stack.slice(0, 2000), handled, mechanism, frames: JSON.stringify(frames), debug_ids: "{}", url: page, ...(o.release ? { release: o.release } : {}) } }],
      });
      fetch(url, { method: "POST", body, keepalive: true, headers: { "content-type": "text/plain;charset=UTF-8" } }).catch(() => 0);
    } catch {
      /* never throw into the host app */
    }
  };
  const onError = (ev: ErrorEvent): void => send?.(ev.error ?? { message: ev.message }, "onerror", false);
  const onRejection = (ev: PromiseRejectionEvent): void => send?.(ev.reason, "unhandledrejection", false);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  (globalThis as Record<symbol, unknown>)[KEY] = {
    handoff: (fn: (e: unknown) => void) => {
      forward = fn;
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    },
  };
}

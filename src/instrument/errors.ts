import { scrubUrl, type Ctx, type Uninstall } from "./ctx";

export interface Frame {
  filename: string;
  function: string;
  lineno: number;
  colno: number;
}

const V8 = /^\s*at (?:async )?(?:(.*?) \()?(.+?):(\d+):(\d+)\)?\s*$/;
const GECKO = /^\s*(.*?)@(.+?):(\d+):(\d+)\s*$/;

/**
 * V8 and Gecko/Safari stack text to frames. Returned oldest call first (the worker's
 * `ErrorEventV1` convention: the innermost frame is last), capped at 50.
 */
export function parseStack(stack: string): Frame[] {
  const out: Frame[] = [];
  for (const line of stack.split("\n")) {
    const m = V8.exec(line) ?? GECKO.exec(line);
    if (m) out.push({ function: m[1] || "?", filename: m[2]!, lineno: +m[3]!, colno: +m[4]! });
  }
  return out.slice(0, 50).reverse();
}

interface DebugIds {
  _wtDebugIds?: Record<string, string>;
}

/** filename to debug id, only for files that appear in the stack (keeps the event small). */
function debugIdsFor(frames: Frame[]): Record<string, string> {
  const all = (window as unknown as DebugIds)._wtDebugIds ?? {};
  const out: Record<string, string> = {};
  for (const f of frames) {
    let id = all[f.filename];
    if (!id) {
      try {
        id = all[new URL(f.filename).pathname];
      } catch {
        /* relative or opaque filename */
      }
    }
    if (id) out[f.filename] = id;
  }
  return out;
}

const DEDUPE_MS = 5000;

export function installErrors(ctx: Ctx): Uninstall {
  const seen = new Map<string, number>();

  const report = (type: string, message: string, stack: string | undefined, handled: boolean, mechanism: string): void => {
    const frames = stack ? parseStack(stack) : [];
    const top = frames[frames.length - 1];
    const key = `${type}|${message}|${top ? `${top.filename}:${top.lineno}:${top.colno}` : ""}`;
    const now = Date.now();
    if (now - (seen.get(key) ?? -Infinity) < DEDUPE_MS) return;
    seen.set(key, now);
    if (seen.size > 100) for (const [k, t] of seen) if (now - t >= DEDUPE_MS) seen.delete(k);
    const attrs: Record<string, string | boolean> = {
      type,
      message: message.slice(0, 1024),
      handled,
      mechanism,
      frames: JSON.stringify(frames),
      debug_ids: JSON.stringify(debugIdsFor(frames)),
    };
    if (ctx.cfg.release) attrs.release = ctx.cfg.release;
    ctx.emit("error", type, { attrs });
  };

  const onError = (ev: Event): void => {
    const t = ev.target;
    if (t instanceof Element && t !== (document as unknown)) {
      // capture-phase resource failure (img, script, link): errors from elements do not bubble
      const tag = t.tagName;
      if (tag !== "IMG" && tag !== "SCRIPT" && tag !== "LINK") return;
      const src = (t as HTMLImageElement).src ?? (t as HTMLLinkElement).href ?? "";
      if (ctx.isOwn(src)) return;
      report("ResourceError", `Failed to load ${tag.toLowerCase()} ${scrubUrl(src)}`, undefined, false, "resource");
      return;
    }
    const e = ev as ErrorEvent;
    const err = e.error as { name?: string; stack?: string } | null | undefined;
    report(err?.name ?? "Error", e.message ?? "", err?.stack, false, "onerror");
  };
  const onRejection = (ev: Event): void => {
    const r = (ev as PromiseRejectionEvent).reason as { name?: string; message?: string; stack?: string } | unknown;
    const isObj = typeof r === "object" && r !== null;
    const o = r as { name?: string; message?: string; stack?: string };
    report(isObj ? (o.name ?? "UnhandledRejection") : "UnhandledRejection", isObj ? (o.message ?? "") : String(r), isObj ? o.stack : undefined, false, "unhandledrejection");
  };
  const onCsp = (ev: Event): void => {
    const e = ev as SecurityPolicyViolationEvent;
    report("CSPViolation", `${e.violatedDirective} blocked ${scrubUrl(e.blockedURI)}`, undefined, false, "csp");
  };

  window.addEventListener("error", onError, true);
  window.addEventListener("unhandledrejection", onRejection);
  document.addEventListener("securitypolicyviolation", onCsp);

  const orig = console.error;
  if (ctx.cfg.captureConsoleErrors) {
    console.error = function (...a: unknown[]) {
      try {
        const first = a[0];
        const e = first instanceof Error ? first : undefined;
        report(e?.name ?? "ConsoleError", e?.message ?? a.map(String).join(" "), e?.stack, true, "console");
      } catch {
        /* never break the host's logging */
      }
      return orig.apply(console, a);
    };
  }

  return () => {
    window.removeEventListener("error", onError, true);
    window.removeEventListener("unhandledrejection", onRejection);
    document.removeEventListener("securitypolicyviolation", onCsp);
    if (ctx.cfg.captureConsoleErrors) console.error = orig;
  };
}

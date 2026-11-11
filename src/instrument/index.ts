import type { Attrs, RumEventV1, WatchtowerConfig } from "../config";
import type { LogLevel } from "../logs";
import type { Ctx, NavInfo, Uninstall } from "./ctx";
import { installConsole } from "./console";
import { installErrors } from "./errors";
import { installFrustration } from "./frustration";
import { installLongTasks } from "./longtasks";
import { currentRoute, installNavigation } from "./navigation";
import { installResources } from "./resources";
import { installVitals } from "./vitals";
import { setUrlScrubbing } from "../scrub";

export interface InstallOpts {
  cfg: WatchtowerConfig;
  emit(type: RumEventV1["type"], name: string, extra?: Partial<RumEventV1>): void;
  log(level: LogLevel, message: string, attrs?: Attrs, span?: { trace_id?: string; span_id?: string }): void;
  sessionId(): string;
  extraAttrs?(): Attrs;
  /** local `profiling` option, overridden by remote config; read live */
  profilingEnabled?(): boolean;
  setAttribute?(k: string, v: string): void;
  onVital?(v: import("../config").WtVital): void;
  /** called whenever tracing sets the active view span */
  onSpan?(s: { trace_id: string; span_id: string } | undefined): void;
}

const absolute = (u: string): string => {
  try {
    return new URL(u, location.href).href;
  } catch {
    return u;
  }
};

/**
 * Lazy chunk, loaded by the core after remote config says RUM is on. OTel (tracing) and
 * web-vitals are further lazy chunks behind dynamic imports. Each instrument fails alone.
 */
export async function install(o: InstallOpts): Promise<Uninstall> {
  const { cfg } = o;
  setUrlScrubbing(cfg.urlScrubbing);
  const listeners: Array<(n: NavInfo) => void> = [];
  // a same-origin tunnel endpoint (`/api/wt`) is relative; resource entries and spans carry absolute URLs
  const own = [cfg.endpoint, cfg.otlpEndpoint].filter((p): p is string => !!p).map(absolute);
  const ctx: Ctx = {
    cfg,
    sessionId: o.sessionId,
    extraAttrs: o.extraAttrs,
    onVital: o.onVital,
    route: currentRoute,
    isOwn: (u) => own.some((p) => u.startsWith(p)),
    onNav: (cb) => void listeners.push(cb),
    net: new Map(),
    log: (level, message) => o.log(level, message, {}, ctx.span),
    emit: (type, name, extra = {}) =>
      o.emit(type, name, {
        ...extra,
        // events inherit the active view span unless they carry their own trace
        ...(extra.trace_id ? {} : { trace_id: ctx.span?.trace_id, span_id: ctx.span?.span_id }),
      }),
  };
  let span: Ctx["span"];
  Object.defineProperty(ctx, "span", { get: () => span, set: (s: Ctx["span"]) => { span = s; o.onSpan?.(s); } });
  const undo: Uninstall[] = [];
  const add = (f: () => Uninstall | undefined): void => {
    try {
      const u = f();
      if (u) undo.push(u);
    } catch (e) {
      if (cfg.debug) console.warn("[watchtower] instrument failed", e);
    }
  };
  const addAsync = async (f: () => Promise<Uninstall>): Promise<void> => {
    try {
      undo.push(await f());
    } catch (e) {
      if (cfg.debug) console.warn("[watchtower] instrument failed", e);
    }
  };

  // tracing first, so the document-load span exists before the first events
  await addAsync(async () => (await import("./tracing")).installTracing(ctx));
  add(() => installNavigation(ctx, listeners));
  add(() => installErrors(ctx));
  add(() => installConsole(ctx));
  add(() => installResources(ctx));
  add(() => installLongTasks(ctx));
  add(() => installFrustration(ctx));
  await addAsync(() => installVitals(ctx));
  // opt-in, its own lazy chunk: nothing is fetched or patched without the `storage` option
  if (cfg.storage) await addAsync(async () => (await import("./storage")).installStorage(ctx));
  const enabled = o.profilingEnabled;
  if (enabled?.()) {
    await addAsync(async () =>
      (await import("../profiling")).installProfiling(ctx, { enabled, setAttr: (k, v) => o.setAttribute?.(k, v) }),
    );
  }
  return () => undo.forEach((u) => u());
}

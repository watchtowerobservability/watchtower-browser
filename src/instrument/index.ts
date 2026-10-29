import type { Attrs, RumEventV1, WatchtowerConfig } from "../config";
import type { Ctx, NavInfo, Uninstall } from "./ctx";
import { installErrors } from "./errors";
import { installFrustration } from "./frustration";
import { installLongTasks } from "./longtasks";
import { currentRoute, installNavigation } from "./navigation";
import { installResources } from "./resources";
import { installVitals } from "./vitals";

export interface InstallOpts {
  cfg: WatchtowerConfig;
  emit(type: RumEventV1["type"], name: string, extra?: Partial<RumEventV1>): void;
  sessionId(): string;
  extraAttrs?(): Attrs;
  /** local `profiling` option, overridden by remote config; read live */
  profilingEnabled?(): boolean;
  setAttribute?(k: string, v: string): void;
}

/**
 * Lazy chunk, loaded by the core after remote config says RUM is on. OTel (tracing) and
 * web-vitals are further lazy chunks behind dynamic imports. Each instrument fails alone.
 */
export async function install(o: InstallOpts): Promise<Uninstall> {
  const { cfg } = o;
  const listeners: Array<(n: NavInfo) => void> = [];
  const own = [cfg.endpoint, cfg.otlpEndpoint].filter((p): p is string => !!p);
  const ctx: Ctx = {
    cfg,
    sessionId: o.sessionId,
    extraAttrs: o.extraAttrs,
    route: currentRoute,
    isOwn: (u) => own.some((p) => u.startsWith(p)),
    onNav: (cb) => void listeners.push(cb),
    net: new Map(),
    emit: (type, name, extra = {}) =>
      o.emit(type, name, {
        ...extra,
        // events inherit the active view span unless they carry their own trace
        ...(extra.trace_id ? {} : { trace_id: ctx.span?.trace_id, span_id: ctx.span?.span_id }),
      }),
  };
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
  add(() => installResources(ctx));
  add(() => installLongTasks(ctx));
  add(() => installFrustration(ctx));
  await addAsync(() => installVitals(ctx));
  const enabled = o.profilingEnabled;
  if (enabled?.()) {
    await addAsync(async () =>
      (await import("../profiling")).installProfiling(ctx, { enabled, setAttr: (k, v) => o.setAttribute?.(k, v) }),
    );
  }
  return () => undo.forEach((u) => u());
}

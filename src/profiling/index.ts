import type { Ctx, Uninstall } from "../instrument/ctx";
import { toFolded } from "./folded";
import { profilerCtor, startProfiler, type RunningProfiler } from "./selfprofiler";

export const WINDOW_MS = 10_000;
export const DEFAULT_SAMPLE = 0.05;
/** Lets the replay recorder start first (never profile during replay start). */
export const START_DELAY_MS = 3000;

export interface ProfilingOpts {
  /** live check of local config and remote config; false at any point stops and discards */
  enabled(): boolean;
  setAttr(k: string, v: string): void;
  /** fraction of sessions profiled */
  rate?: number;
}

/** Stable per-session draw in [0,1) (FNV-1a), so a session is either profiled or not. */
function draw(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return (h >>> 0) / 2 ** 32;
}

export function installProfiling(ctx: Ctx, o: ProfilingOpts): Uninstall {
  const P = profilerCtor();
  if (!P) {
    if (o.enabled()) o.setAttr("wt.sdk.profiling", "unsupported");
    return () => undefined;
  }
  if (draw(ctx.sessionId()) >= (o.rate ?? DEFAULT_SAMPLE)) return () => undefined;

  let running: { p: RunningProfiler; route: string; trace?: string; timer: ReturnType<typeof setTimeout> } | undefined;
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  let done = false;

  const finish = async (upload: boolean): Promise<void> => {
    const r = running;
    running = undefined;
    if (!r) return;
    clearTimeout(r.timer);
    try {
      const trace = await r.p.stop();
      const body = upload && o.enabled() ? toFolded(trace) : "";
      if (body) await send(ctx, r.route, r.trace, body);
    } catch {
      /* a profile is best effort */
    }
  };

  // one window per view
  const begin = (): void => {
    if (done || running || !o.enabled()) return;
    try {
      const p = startProfiler(P);
      running = {
        p,
        route: ctx.route(),
        trace: ctx.span?.trace_id,
        timer: setTimeout(() => void finish(true), WINDOW_MS),
      };
    } catch {
      o.setAttr("wt.sdk.profiling", "unsupported"); // e.g. missing Document-Policy header
    }
  };
  ctx.onNav(() => {
    void finish(true).then(() => {
      startTimer = setTimeout(begin, 0);
    });
  });
  startTimer = setTimeout(begin, START_DELAY_MS);

  return () => {
    done = true;
    clearTimeout(startTimer);
    void finish(false);
  };
}

async function send(ctx: Ctx, route: string, trace: string | undefined, body: string): Promise<void> {
  const q = new URLSearchParams({ service: ctx.cfg.service, route, session: ctx.sessionId() });
  if (ctx.cfg.release) q.set("release", ctx.cfg.release);
  if (trace) q.set("trace", trace);
  await fetch(`${ctx.cfg.endpoint.replace(/\/$/, "")}/v1/rum/profiles?${q}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ctx.cfg.publishableKey}`, "Content-Type": "text/plain" },
    body,
  });
}

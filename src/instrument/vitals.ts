import type { Attrs } from "../config";
import { deviceClass, scrubUrl, type Ctx, type Uninstall } from "./ctx";

/** Google thresholds: [good upper bound, needs-improvement upper bound]. */
export const THRESHOLDS: Record<string, [number, number]> = {
  LCP: [2500, 4000],
  INP: [200, 500],
  CLS: [0.1, 0.25],
  FCP: [1800, 3000],
  TTFB: [800, 1800],
};

export function rate(name: string, v: number): "good" | "needs-improvement" | "poor" {
  const t = THRESHOLDS[name];
  if (!t) return "good";
  return v <= t[0] ? "good" : v <= t[1] ? "needs-improvement" : "poor";
}

/** The slice of a web-vitals attribution metric we read. */
export interface MetricLike {
  name: string;
  value: number;
  navigationType?: string;
  attribution?: {
    target?: string;
    interactionTarget?: string;
    largestShiftTarget?: string;
    url?: string;
    loadState?: string;
  };
}

export function vitalAttrs(m: MetricLike, ctx: Ctx): Attrs {
  const a = m.attribution ?? {};
  const out: Attrs = {
    rating: rate(m.name, m.value),
    route: ctx.route(),
    device_class: deviceClass(),
    url: scrubUrl(a.url ?? location.href),
  };
  const el = a.target ?? a.largestShiftTarget;
  if (el) out.element = el.slice(0, 256);
  if (a.interactionTarget) out.interaction_target = a.interactionTarget.slice(0, 256);
  if (a.loadState) out.load_state = a.loadState;
  if (m.navigationType) out.navigation_type = m.navigationType;
  const conn = (navigator as { connection?: { effectiveType?: string } }).connection?.effectiveType;
  if (conn) out.connection = conn;
  return out;
}

/** web-vitals is a lazy chunk (not part of the 12 KiB core). */
export async function installVitals(ctx: Ctx): Promise<Uninstall> {
  const wv = await import("web-vitals/attribution");
  const on = (m: MetricLike): void => ctx.emit("vital", m.name, { value: m.value, attrs: vitalAttrs(m, ctx) });
  const cb = on as (m: unknown) => void;
  wv.onLCP(cb);
  wv.onINP(cb);
  wv.onCLS(cb);
  wv.onFCP(cb);
  wv.onTTFB(cb);
  return () => undefined; // web-vitals has no unsubscribe; the emitter drops events after stop()
}

import type { Attrs } from "../config";
import type { WtVital } from "../config";
import { uuid } from "../ids";
import { deviceClass, scrubUrl, stripQuery, type Ctx, type Uninstall } from "./ctx";

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
  // `vital` hook: the latest value per vital, handed over once when the page is hidden (final)
  let navId = uuid();
  const latest = new Map<string, MetricLike>();
  const fired = new Set<string>();
  const on = (m: MetricLike): void => {
    ctx.emit("vital", m.name, { value: m.value, attrs: { ...vitalAttrs(m, ctx), navigation_id: navId } });
    if (!fired.has(m.name)) latest.set(m.name, m);
  };
  const finalize = (): void => {
    for (const [name, m] of latest) {
      fired.add(name);
      ctx.onVital?.({ name: name as WtVital["name"], value: m.value, rating: rate(name, m.value), navigation_id: navId, url: stripQuery(location.href), final: true });
    }
    latest.clear();
  };
  const onHidden = (): void => {
    if (document.visibilityState === "hidden") finalize();
  };
  // a bfcache restore is a new page view
  const onShow = (e: Event): void => {
    if ((e as PageTransitionEvent).persisted) {
      navId = uuid();
      fired.clear();
    }
  };
  document.addEventListener("visibilitychange", onHidden);
  window.addEventListener("pagehide", finalize);
  window.addEventListener("pageshow", onShow);
  const cb = on as (m: unknown) => void;
  wv.onLCP(cb);
  wv.onINP(cb);
  wv.onCLS(cb);
  wv.onFCP(cb);
  wv.onTTFB(cb);
  // web-vitals has no unsubscribe; the emitter drops events after stop()
  return () => {
    document.removeEventListener("visibilitychange", onHidden);
    window.removeEventListener("pagehide", finalize);
    window.removeEventListener("pageshow", onShow);
  };
}

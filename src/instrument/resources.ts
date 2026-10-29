import type { RumEventV1 } from "../config";
import { matches, scrubUrl, type Ctx, type Uninstall } from "./ctx";

type Resource = Pick<
  PerformanceResourceTiming,
  "name" | "initiatorType" | "duration" | "transferSize" | "startTime"
> & { responseStatus?: number };

/** One RUM `resource` event for a Resource Timing entry; null for the SDK's own and data URLs. */
export function resourceEvent(e: Resource, ctx: Ctx): Partial<RumEventV1> & { name: string } | null {
  if (e.name.startsWith("data:") || e.name.startsWith("blob:") || ctx.isOwn(e.name)) return null;
  if (ctx.cfg.ignoreUrls?.some((m) => matches(m, e.name))) return null;
  const url = scrubUrl(e.name);
  const net = ctx.net.get(url);
  const status = net?.status ?? (e.responseStatus || undefined);
  const failed = net?.failed === true || (status !== undefined && status >= 400);
  return {
    name: e.initiatorType || "other",
    value: Math.round(e.duration),
    trace_id: net?.trace_id,
    attrs: {
      url,
      initiator_type: e.initiatorType,
      transfer_size: e.transferSize,
      ...(status === undefined ? {} : { status }),
      ...(failed ? { failed: true } : {}),
    },
  };
}

export function installResources(ctx: Ctx): Uninstall {
  if (typeof PerformanceObserver === "undefined") return () => undefined;
  const po = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      const r = resourceEvent(e as PerformanceResourceTiming, ctx);
      if (r) ctx.emit("resource", r.name!, r);
    }
  });
  try {
    po.observe({ type: "resource", buffered: true });
  } catch {
    return () => undefined;
  }
  return () => po.disconnect();
}

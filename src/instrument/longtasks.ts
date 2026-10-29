import type { Ctx, Uninstall } from "./ctx";

const MIN_MS = 50;
const MAX_PER_VIEW = 20;

/** `longtask` and `long-animation-frame` entries over 50 ms, at most 20 per view. */
export function installLongTasks(ctx: Ctx): Uninstall {
  if (typeof PerformanceObserver === "undefined") return () => undefined;
  let count = 0;
  ctx.onNav(() => (count = 0));
  const observers: PerformanceObserver[] = [];
  for (const type of ["longtask", "long-animation-frame"]) {
    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.duration < MIN_MS || count >= MAX_PER_VIEW) continue;
          count++;
          const blocking = (e as { blockingDuration?: number }).blockingDuration;
          ctx.emit("longtask", type, {
            value: Math.round(e.duration),
            attrs: {
              start_time: Math.round(e.startTime),
              route: ctx.route(),
              ...(blocking === undefined ? {} : { blocking_duration: Math.round(blocking) }),
            },
          });
        }
      });
      po.observe({ type, buffered: true });
      observers.push(po);
    } catch {
      /* entry type unsupported in this browser */
    }
  }
  return () => observers.forEach((o) => o.disconnect());
}

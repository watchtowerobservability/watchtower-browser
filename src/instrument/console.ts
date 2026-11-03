import type { LogLevel } from "../logs";
import type { Ctx, Uninstall } from "./ctx";

type Level = LogLevel;

const fmt = (a: unknown): string => {
  if (typeof a === "string") return a;
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  try {
    return JSON.stringify(a) ?? String(a);
  } catch {
    return String(a);
  }
};

/** Console capture (Faro parity): the configured levels become OTLP log records. */
export function installConsole(ctx: Ctx): Uninstall | undefined {
  const levels = ctx.cfg.captureConsole ?? [];
  if (!levels.length) return undefined;
  const orig = new Map<Level, (...a: unknown[]) => void>();
  let inside = false; // our own emit path must not log back into itself
  for (const lvl of levels) {
    const o = console[lvl];
    if (typeof o !== "function") continue;
    orig.set(lvl, o);
    console[lvl] = function (...a: unknown[]) {
      if (!inside) {
        inside = true;
        try {
          ctx.log(lvl, a.map(fmt).join(" ").slice(0, 2048));
        } catch {
          /* never break the host's logging */
        } finally {
          inside = false;
        }
      }
      return o.apply(console, a);
    };
  }
  return () => orig.forEach((o, lvl) => void (console[lvl] = o));
}

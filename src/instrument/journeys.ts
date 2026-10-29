import type { Attrs } from "../config";

type Emit = (name: string, attrs: Attrs) => void;

export interface Journey {
  step(name: string, o?: { ok?: boolean }): void;
  fail(reason: string): void;
}

/** Explicit funnels only: no automatic funnel inference (R8). `attempt` counts repeats of a step. */
export function makeJourney(name: string, emit: Emit, now: () => number = Date.now): Journey {
  let prev = now();
  const tries = new Map<string, number>();
  const step = (s: string, o?: { ok?: boolean }): void => {
    const t = now();
    const attempt = (tries.get(s) ?? 0) + 1;
    tries.set(s, attempt);
    emit(name, { journey: name, step: s, ok: o?.ok ?? true, duration_ms_since_prev: t - prev, attempt });
    prev = t;
  };
  return { step, fail: (reason) => step(reason, { ok: false }) };
}

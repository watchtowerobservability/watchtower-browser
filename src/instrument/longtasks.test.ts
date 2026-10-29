import { afterEach, describe, expect, it, vi } from "vitest";
import { installLongTasks } from "./longtasks";
import { mkCtx } from "./testutil";

afterEach(() => vi.unstubAllGlobals());

/** Fake PerformanceObserver that lets the test push entries. */
function fakePO() {
  const cbs: Array<(l: { getEntries(): unknown[] }) => void> = [];
  vi.stubGlobal(
    "PerformanceObserver",
    class {
      constructor(cb: (l: { getEntries(): unknown[] }) => void) {
        cbs.push(cb);
      }
      observe() {}
      disconnect() {}
    },
  );
  return (entries: unknown[]) => cbs[0]!({ getEntries: () => entries });
}

describe("longtasks", () => {
  it("long_tasks_over_50ms_capped_20_per_view", () => {
    const push = fakePO();
    const { c, events, nav } = mkCtx();
    installLongTasks(c);
    const e = (d: number) => ({ duration: d, startTime: 1 });
    push([e(10), ...Array.from({ length: 30 }, () => e(80))]);
    expect(events).toHaveLength(20);
    expect(events.every((x) => x.type === "longtask" && x.value === 80)).toBe(true);
    nav({ route: "/b", previous: "/a" });
    push([e(90)]);
    expect(events).toHaveLength(21);
  });
});

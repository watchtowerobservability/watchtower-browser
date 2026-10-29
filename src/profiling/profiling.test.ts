import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkCtx } from "../instrument/testutil";
import { toFolded, type ProfilerTrace } from "./folded";
import { installProfiling, START_DELAY_MS, WINDOW_MS } from "./index";

const TRACE: ProfilerTrace = {
  resources: ["https://app.test/a.js?token=secret", "https://app.test/b.js"],
  frames: [
    { name: "main", resourceId: 0, line: 10 },
    { name: "work", resourceId: 1, line: 3 },
    { name: "", resourceId: 1, line: 7 },
  ],
  stacks: [{ frameId: 0 }, { parentId: 0, frameId: 1 }, { parentId: 0, frameId: 2 }],
  samples: [
    { timestamp: 0, stackId: 1 },
    { timestamp: 10, stackId: 1 },
    { timestamp: 20, stackId: 2 },
    { timestamp: 30 },
  ],
};

let stops = 0;
let started = 0;
function fakeProfiler() {
  vi.stubGlobal(
    "Profiler",
    class {
      constructor() {
        started++;
      }
      async stop() {
        stops++;
        return TRACE;
      }
    },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  stops = started = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const opts = (over: Partial<Parameters<typeof installProfiling>[1]> = {}) => {
  const attrs: Record<string, string> = {};
  return { attrs, o: { enabled: () => true, setAttr: (k: string, v: string) => void (attrs[k] = v), rate: 1, ...over } };
};

describe("profiling", () => {
  it("unsupported_browser_is_noop", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const { c } = mkCtx();
    const { attrs, o } = opts();
    installProfiling(c, o);
    await vi.advanceTimersByTimeAsync(START_DELAY_MS + WINDOW_MS + 1);
    expect(f).not.toHaveBeenCalled();
    expect(attrs["wt.sdk.profiling"]).toBe("unsupported");
  });

  it("trace_converted_to_folded_stacks", () => {
    expect(toFolded(TRACE)).toBe("main@https://app.test/a.js:10;work@https://app.test/b.js:3 2\nmain@https://app.test/a.js:10;(anonymous)@https://app.test/b.js:7 1\n");
  });

  it("only_sampled_sessions_profile", async () => {
    fakeProfiler();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 202 })));
    const { c } = mkCtx();
    installProfiling(c, opts({ rate: 0 }).o);
    await vi.advanceTimersByTimeAsync(START_DELAY_MS + WINDOW_MS + 1);
    expect(started).toBe(0);
    installProfiling(c, opts({ rate: 1 }).o);
    await vi.advanceTimersByTimeAsync(START_DELAY_MS + 1);
    expect(started).toBe(1);
  });

  it("window_capped_10s", async () => {
    fakeProfiler();
    const f = vi.fn(async (_u: string, _i?: RequestInit) => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", f);
    const { c } = mkCtx();
    installProfiling(c, opts().o);
    await vi.advanceTimersByTimeAsync(START_DELAY_MS + WINDOW_MS - 1);
    expect(stops).toBe(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(stops).toBe(1);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toContain("https://edge.test/v1/rum/profiles?");
    expect(url).toContain("service=web");
    expect(String(init!.body)).not.toContain("secret");
    // one window per view: no second start without a navigation
    await vi.advanceTimersByTimeAsync(WINDOW_MS * 2);
    expect(started).toBe(1);
  });

  it("profiling_stops_when_remote_config_disables", async () => {
    fakeProfiler();
    const f = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", f);
    let on = true;
    const { c } = mkCtx();
    installProfiling(c, opts({ enabled: () => on }).o);
    await vi.advanceTimersByTimeAsync(START_DELAY_MS + 1);
    expect(started).toBe(1);
    on = false;
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    expect(stops).toBe(1);
    expect(f).not.toHaveBeenCalled(); // discarded, not uploaded
  });
});

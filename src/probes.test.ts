import { describe, expect, it, vi } from "vitest";
import { capture, compile, createProbes, type ProbeDef } from "./probes";

const def = (over: Partial<ProbeDef> = {}): ProbeDef => ({
  id: "prb_1", kind: "snapshot", location: { function: "pay" }, condition: "", message: "",
  capture: {}, max_rate_per_min: 2, expires_at: 0, ...over,
});

describe("probes", () => {
  it("probe_fires_and_respects_rate", () => {
    const emit = vi.fn();
    const p = createProbes({ endpoint: "https://e", key: "k", service: "s", emit, now: () => 120_000 });
    const vars = vi.fn(() => ({ n: 5, user: { tier: "pro" } }));
    p.hit("pay", vars);
    expect(vars).not.toHaveBeenCalled(); // no probe: the thunk never runs
    p.set([def({ condition: "n > 3 && user.tier == 'pro'" })]);
    for (let i = 0; i < 5; i++) p.hit("pay", vars);
    expect(emit).toHaveBeenCalledTimes(2);
    const attrs = emit.mock.calls[0]![1] as Record<string, string>;
    expect(attrs["probe.id"]).toBe("prb_1");
    expect(attrs["code.snapshot.user.tier"]).toBe("pro");
    expect(Object.keys(attrs).some((k) => k.startsWith("wt."))).toBe(false);
  });

  it("condition_rejects_calls_and_capture_is_bounded", () => {
    expect(() => compile("len(x) > 1")).toThrow();
    expect(compile("r in ['eu','us'] && !(s contains 'x')")({ r: "eu", s: "abc" })).toBe(true);
    const out = capture({ a: { b: { c: { d: { e: 1 } } } }, big: "x".repeat(5000) }, 3, 8192);
    expect(out["a.b.c.d"]).toBe("[depth limit]");
    expect(out.big!.length).toBe(1024);
  });
});

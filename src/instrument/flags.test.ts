import { describe, expect, it } from "vitest";
import { growthBookAdapter, launchDarklyAdapter, makeFlagRecorder, openFeatureHook } from "./flags";

function rec() {
  const events: Array<[string, Record<string, unknown>]> = [];
  const attrs: Record<string, string> = {};
  return { events, attrs, record: makeFlagRecorder((k, a) => events.push([k, a]), (k, v) => (attrs[k] = v)) };
}

describe("flags", () => {
  it("flag_adapter_launchdarkly_records_change", () => {
    const { events, attrs, record } = rec();
    let cb: (c: Record<string, { current: unknown }>) => void = () => undefined;
    launchDarklyAdapter({ on: (_e, f) => (cb = f) }).attach(record);
    cb({ "new-checkout": { current: true } });
    expect(events).toEqual([["new-checkout", { value: "true" }]]);
    expect(attrs["flag.new-checkout"]).toBe("true");
  });

  it("openfeature_and_growthbook_adapters_record", () => {
    const { events, record } = rec();
    const hook = openFeatureHook();
    hook.attach(record);
    hook.after({}, { flagKey: "a", value: "v1" });
    let tcb: (e: { key: string }, r: { key: string }) => void = () => undefined;
    growthBookAdapter({ setTrackingCallback: (f) => (tcb = f) }).attach(record);
    tcb({ key: "exp" }, { key: "variant-b" });
    expect(events.map((e) => e[1].value)).toEqual(["v1", "variant-b"]);
  });

  it("flags_capped_at_50", () => {
    const { events, attrs, record } = rec();
    for (let i = 0; i < 60; i++) record(`k${i}`, i);
    expect(events).toHaveLength(50);
    expect(Object.keys(attrs)).toHaveLength(50);
    record("k0", "changed"); // known keys still update
    expect(attrs["flag.k0"]).toBe("changed");
  });

  it("flag_values_truncated_128", () => {
    const { attrs, record } = rec();
    record("k", "x".repeat(500));
    expect(attrs["flag.k"]).toHaveLength(128);
  });
});

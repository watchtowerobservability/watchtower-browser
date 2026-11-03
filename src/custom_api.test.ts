import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { init, syntheticAttrs } from "./index";
import { bodyOf, stubFetch } from "./testutil";

const cfg = { publishableKey: "wtp_abcd1234_x", endpoint: "https://edge.test", service: "web" };
beforeEach(() => sessionStorage.clear());
afterEach(() => vi.unstubAllGlobals());

it("log_is_an_otlp_record_and_pause_holds_everything", async () => {
  const f = stubFetch();
  const c = init({ ...cfg, otlpEndpoint: "https://otlp.test" });
  c.pause();
  c.log("held");
  c.unpause();
  c.log("paid", { level: "warn", attrs: { order: "o1" } });
  void c.shutdown();
  const logCall = await vi.waitFor(() => {
    const call = (fetch as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls.find(([u]) => String(u).endsWith("/v1/logs"));
    expect(call).toBeDefined();
    return call!;
  }, { timeout: 3000 });
  expect(f).toBeDefined();
  const recs = JSON.parse(logCall[1].body as string).resourceLogs[0].scopeLogs[0].logRecords;
  expect(recs).toHaveLength(1);
  expect(recs[0]).toMatchObject({ severityText: "WARN", body: { stringValue: "paid" } });
  expect(recs[0].attributes).toContainEqual({ key: "order", value: { stringValue: "o1" } });
});

it("measure_and_event_use_existing_kinds", async () => {
  const f = stubFetch();
  const c = init(cfg);
  c.measure("cart.items", 3);
  c.measure("bad", Number.NaN);
  c.event("coupon_applied", { code: "X" });
  void c.shutdown();
  await vi.waitFor(() => expect(f.events().length).toBeGreaterThan(0), { timeout: 3000 });
  const b = bodyOf(f.events()[0]!.init);
  const ev = b.events as Array<{ type: string; name: string; value?: number; attrs: Record<string, unknown> }>;
  expect(ev.map((e) => [e.type, e.name])).toEqual([["vital", "custom.cart.items"], ["action", "coupon_applied"]]);
  expect(ev[0]!.value).toBe(3);
});

it("synthetic_sessions_are_tagged", () => {
  expect(syntheticAttrs({ __WT_SYNTHETIC__: { check_id: "chk1", run_id: "r9" } })).toEqual({
    synthetic: true, "synthetic.source": "watchtower", "synthetic.check_id": "chk1", "synthetic.run_id": "r9",
  });
  expect(syntheticAttrs({ k6: {} })).toEqual({ synthetic: true, "synthetic.source": "k6" });
  expect(syntheticAttrs({})).toEqual({});
});

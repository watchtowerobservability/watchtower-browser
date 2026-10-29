import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { init } from "./index";
import { bodyOf, stubFetch } from "./testutil";

const cfg = { publishableKey: "wtp_abcd1234_x", endpoint: "https://edge.test", service: "web" };

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { posthog?: unknown }).posthog;
});

async function sent(f: ReturnType<typeof stubFetch>) {
  await vi.waitFor(() => expect(f.events().length).toBeGreaterThan(0), { timeout: 3000 });
  return bodyOf(f.events()[0]!.init);
}

describe("posthog link", () => {
  it("posthog_ids_attached_when_present", async () => {
    (globalThis as any).posthog = { get_distinct_id: () => "d1", get_session_id: () => "s1" };
    const f = stubFetch();
    const c = init(cfg);
    c.flag("a", 1);
    void c.shutdown();
    const b = await sent(f);
    expect(b.attrs["posthog.distinct_id"]).toBe("d1");
    expect(b.attrs["posthog.session_id"]).toBe("s1");
  });

  it("posthog_ids_absent_when_missing_no_throw", async () => {
    const f = stubFetch();
    const c = init(cfg);
    c.flag("a", 1);
    void c.shutdown();
    const b = await sent(f);
    expect(b.attrs["posthog.distinct_id"]).toBeUndefined();
  });
});

describe("batching", () => {
  it("batch_flushes_at_50_events", async () => {
    const f = stubFetch();
    const c = init(cfg);
    await vi.waitFor(() => expect(f.calls.length).toBe(1)); // config fetched, transport started
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 50; i++) c.flag(`k${i}`, i);
    const b = await sent(f);
    expect(b.events).toHaveLength(50);
    expect(b.attrs["wt.sample_rate"]).toBe(1);
  });

  it("unload_uses_sendbeacon", async () => {
    stubFetch();
    const beacon = vi.fn(() => true);
    vi.stubGlobal("navigator", { ...navigator, userAgent: "t", sendBeacon: beacon });
    const c = init(cfg);
    await new Promise((r) => setTimeout(r, 20)); // config resolved
    c.flag("a", 1);
    window.dispatchEvent(new Event("pagehide"));
    expect(beacon).toHaveBeenCalledOnce();
    expect((beacon.mock.calls[0] as unknown as [string])[0]).toContain("/v1/rum/events?k=wtp_abcd1234_x");
  });
});

describe("safety and privacy", () => {
  it("public_api_never_throws", async () => {
    stubFetch();
    const c = init({ ...cfg, beforeSend: () => { throw new Error("boom"); } });
    expect(() => {
      c.captureError(new Error("x"));
      c.flag("k", {});
      c.journey("j").step("s");
      c.setUser({ id: "u" });
      c.setAttribute("a", 1);
    }).not.toThrow();
    await expect(c.shutdown()).resolves.toBeUndefined();
    const bad = init(undefined as never);
    expect(() => bad.captureError("x")).not.toThrow();
  });

  it("user_id_hashed_before_send", async () => {
    const f = stubFetch();
    const c = init({ ...cfg, user: { id: "alice@example.com" } });
    c.flag("a", 1);
    void c.shutdown();
    const b = await sent(f);
    expect(b.user.id_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(b)).not.toContain("alice@example.com");
  });

  it("before_send_null_drops_event", async () => {
    const f = stubFetch();
    const c = init({ ...cfg, beforeSend: (e) => (e.name === "drop" ? null : e) });
    c.flag("drop", 1);
    c.flag("keep", 1);
    void c.shutdown();
    const b = await sent(f);
    expect(b.events.map((e: { name: string }) => e.name)).toEqual(["keep"]);
  });

  it("unsampled_session_sends_nothing_but_errors_follow_error_rate", async () => {
    const f = stubFetch();
    const c = init({ ...cfg, sampleRate: 0, errorSampleRate: 1 });
    c.flag("x", 1);
    c.captureError(new Error("e"));
    void c.shutdown();
    const b = await sent(f);
    expect(b.events.map((e: { type: string }) => e.type)).toEqual(["error"]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { init as initSdk, type WatchtowerClient } from "./index";
import { bodyOf, stubFetch } from "./testutil";

const cfg = { publishableKey: "wtp_abcd1234_x", endpoint: "https://edge.test", service: "web" };

// every client a test starts is stopped after it, so its pagehide listener cannot fire in later tests
const live: WatchtowerClient[] = [];
const init: typeof initSdk = (c) => {
  const x = initSdk(c);
  live.push(x);
  return x;
};

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  for (const x of live.splice(0)) x.stop();
  vi.unstubAllGlobals();
  delete (globalThis as { posthog?: unknown }).posthog;
});

async function sent(f: ReturnType<typeof stubFetch>) {
  await vi.waitFor(() => expect(f.events().length).toBeGreaterThan(0), { timeout: 3000 });
  return bodyOf(f.events()[0]!.init);
}

describe("lucida link", () => {
  it("lucida_session_id_attached_when_present", async () => {
    (globalThis as any).lucida = { getSessionId: () => "ls1" };
    const { lucidaAttrs } = await import("./lucida");
    expect(lucidaAttrs()["lucida.session_id"]).toBe("ls1");
    delete (globalThis as any).lucida;
    expect(lucidaAttrs()).toEqual({});
  });

  it("lucida_distinct_id_attached_when_present", async () => {
    (globalThis as any).lucida = { getSessionId: () => "ls1", getDistinctId: () => "u-7" };
    const { lucidaAttrs } = await import("./lucida");
    expect(lucidaAttrs()).toEqual({ "lucida.session_id": "ls1", "lucida.distinct_id": "u-7" });
    delete (globalThis as any).lucida;
  });

  it("init_lucida_client_wins_over_the_global", async () => {
    (globalThis as any).lucida = { getSessionId: () => "global" };
    const { lucidaAttrs } = await import("./lucida");
    expect(lucidaAttrs({ getSessionId: () => "mine" })["lucida.session_id"]).toBe("mine");
    expect(lucidaAttrs({ getSessionId: () => "" })["lucida.session_id"]).toBe("global");
    delete (globalThis as any).lucida;
  });
});

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

describe("default release", () => {
  afterEach(() => {
    document.head.innerHTML = "";
    delete (globalThis as { __WT_RELEASE__?: unknown }).__WT_RELEASE__;
  });
  it("reads_data_release_meta_or_global_when_init_has_none", async () => {
    const s = document.createElement("script");
    s.dataset.release = "1.2.3";
    document.head.append(s);
    const f = stubFetch();
    const c = init(cfg);
    c.flag("a", 1);
    void c.shutdown();
    expect((await sent(f)).app.release).toBe("1.2.3");
    s.remove();
    (globalThis as { __WT_RELEASE__?: string }).__WT_RELEASE__ = "9.9.9";
    const { defaultRelease } = await import("./config");
    expect(defaultRelease()).toBe("9.9.9");
  });
  it("explicit_release_wins", async () => {
    const f = stubFetch();
    const c = init({ ...cfg, release: "2.0.0" });
    c.flag("a", 1);
    void c.shutdown();
    expect((await sent(f)).app.release).toBe("2.0.0");
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

describe("urls and tunnel", () => {
  it("page_url_is_scrubbed_and_opt_out_keeps_the_query", async () => {
    history.replaceState(null, "", "/reset/a1b2c3d4e5f6?token=s3cret#x");
    let f = stubFetch();
    let c = init(cfg);
    c.flag("a", 1);
    void c.shutdown();
    expect((await sent(f)).page.url).toBe(`${location.origin}/reset/:redacted`);

    sessionStorage.clear();
    f = stubFetch();
    c = init({ ...cfg, urlScrubbing: false });
    c.flag("a", 1);
    void c.shutdown();
    expect((await sent(f)).page.url).toBe(`${location.origin}/reset/a1b2c3d4e5f6?token=s3cret`);
    history.replaceState(null, "", "/");
  });

  it("same_origin_tunnel_endpoint_is_used_as_is", async () => {
    const f = stubFetch();
    const c = init({ ...cfg, endpoint: "/api/wt" });
    c.flag("a", 1);
    void c.shutdown();
    await sent(f);
    expect(f.events()[0]!.url).toBe("/api/wt/v1/rum/events");
    expect(f.calls.some((x) => x.url === "/api/wt/v1/rum/config")).toBe(true);
  });

  it("second_grant_does_not_start_a_new_session", () => {
    stubFetch();
    const c = init({ ...cfg, consent: "pending" });
    c.grantConsent();
    const id = c.sessionId();
    expect(id).not.toBe("");
    c.grantConsent();
    expect(c.sessionId()).toBe(id);
  });
});

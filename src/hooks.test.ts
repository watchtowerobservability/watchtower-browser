import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { init as initSdk, type WatchtowerClient, type WtErrorEvent } from "./index";
import { bodyOf, stubFetch } from "./testutil";

const cfg = { publishableKey: "wtp_abcd1234_x", endpoint: "https://edge.test", service: "web" };
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
  delete (globalThis as any).watchtower;
  delete (globalThis as any).wtx;
});

describe("error hook", () => {
  it("fires_with_payload_and_same_event_id_as_ingest", async () => {
    const f = stubFetch();
    const c = init(cfg);
    const got: WtErrorEvent[] = [];
    c.on("error", (e) => got.push(e));
    c.captureError(new TypeError("x".repeat(400)));
    expect(got).toHaveLength(1);
    const e = got[0]!;
    expect(e.type).toBe("TypeError");
    expect(e.handled).toBe(true);
    expect(e.message).toHaveLength(300);
    expect(e.url).not.toContain("?");
    expect(e.ts).toBeGreaterThan(1e12);
    void c.shutdown();
    await vi.waitFor(() => expect(f.events().length).toBeGreaterThan(0), { timeout: 3000 });
    const sent = bodyOf(f.events()[0]!.init).events.find((x: any) => x.type === "error");
    expect(sent.id).toBe(e.event_id);
  });

  it("throwing_hook_does_not_break_capture_or_other_hooks", async () => {
    const f = stubFetch();
    const c = init(cfg);
    const ok = vi.fn();
    c.on("error", () => {
      throw new Error("boom");
    });
    c.on("error", ok);
    expect(() => c.captureError(new Error("a"))).not.toThrow();
    expect(ok).toHaveBeenCalledTimes(1);
    void c.shutdown();
    await vi.waitFor(() => expect(f.events().length).toBeGreaterThan(0), { timeout: 3000 });
  });

  it("unsubscribe_stops_calls", () => {
    stubFetch();
    const c = init(cfg);
    const cb = vi.fn();
    const off = c.on("error", cb);
    c.captureError(new Error("a"));
    off();
    c.captureError(new Error("b"));
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe("lucida session id", () => {
  it("setAttribute_reaches_the_batch_and_error_events", async () => {
    const f = stubFetch();
    const c = init(cfg);
    c.setAttribute("lucida.session_id", "ls9");
    c.captureError(new Error("a"));
    void c.shutdown();
    await vi.waitFor(() => expect(f.events().length).toBeGreaterThan(0), { timeout: 3000 });
    const b = bodyOf(f.events()[0]!.init);
    expect(b.attrs["lucida.session_id"]).toBe("ls9");
    expect(b.events.find((x: any) => x.type === "error").attrs["lucida.session_id"]).toBe("ls9");
  });
});

describe("exposeGlobal", () => {
  it("off_by_default_for_the_esm_build", () => {
    stubFetch();
    init(cfg);
    expect((globalThis as any).watchtower).toBeUndefined();
  });

  it("true_sets_watchtower_and_fires_ready", () => {
    stubFetch();
    const ready = vi.fn();
    window.addEventListener("watchtower:ready", ready);
    const c = init({ ...cfg, exposeGlobal: true });
    expect((globalThis as any).watchtower).toBe(c);
    expect(ready).toHaveBeenCalledTimes(1);
    window.removeEventListener("watchtower:ready", ready);
  });

  it("string_names_the_global", () => {
    stubFetch();
    const c = init({ ...cfg, exposeGlobal: "wtx" });
    expect((globalThis as any).wtx).toBe(c);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { init } from "./index.js";
import { bodyOf, stubFetch } from "./testutil.js";

const cfg = { publishableKey: "wtp_abcd1234_x", endpoint: "https://edge.test", service: "web" };

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("consent", () => {
  it("pending_sends_nothing_until_granted", async () => {
    const f = stubFetch();
    const c = init({ ...cfg, consent: "pending" });
    c.event("before");
    c.captureError(new Error("x"));
    await c.shutdown();
    expect(f.calls).toHaveLength(0);
    expect(sessionStorage.getItem("wt.session")).toBeNull();
    expect(c.sessionId()).toBe("");

    c.grantConsent();
    c.event("after");
    void c.shutdown();
    await vi.waitFor(() => expect(f.events().length).toBeGreaterThan(0), { timeout: 3000 });
    expect(sessionStorage.getItem("wt.session")).not.toBeNull();
  });

  it("pending_holds_data_calls_and_replays_them_on_grant", async () => {
    const f = stubFetch();
    const c = init({ ...cfg, consent: "pending" });
    c.event("held-one");
    c.setAttribute("a", "b");
    c.grantConsent();
    void c.shutdown();
    await vi.waitFor(() => expect(JSON.stringify(f.events())).toContain("held-one"), { timeout: 3000 });
  });

  it("pending_queue_is_bounded_and_dropped_on_revoke", async () => {
    const f = stubFetch();
    const c = init({ ...cfg, consent: "pending" });
    for (let i = 0; i < 150; i++) c.event(`e${i}`);
    c.revokeConsent();
    c.grantConsent();
    void c.shutdown();
    await new Promise((r) => setTimeout(r, 100));
    expect(JSON.stringify(f.events())).not.toContain('"e0"');
  });

  it("revoke_never_sends_after_and_deletes_both_offline_databases", async () => {
    const f = stubFetch();
    const beacon = vi.fn(() => true);
    const del = vi.fn();
    vi.stubGlobal("navigator", { ...navigator, sendBeacon: beacon });
    vi.stubGlobal("indexedDB", { deleteDatabase: del, open: () => { throw new Error("no idb"); } });
    const c = init(cfg);
    c.event("queued");
    c.log("queued-log");
    c.revokeConsent();
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pagehide"));
    await new Promise((r) => setTimeout(r, 50));
    await c.shutdown();
    expect(f.calls.filter((x) => x.init.method === "POST")).toHaveLength(0); // the remote-config GET at start is not a send
    expect(beacon).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith("wt-offline");
    expect(del).toHaveBeenCalledWith("wt-offline-logs");
  });

  it("revoke_stops_drops_queue_and_clears_session", async () => {
    const f = stubFetch();
    const c = init(cfg);
    const id = c.sessionId();
    expect(id).not.toBe("");
    c.event("queued");
    c.revokeConsent();
    expect(sessionStorage.getItem("wt.session")).toBeNull();
    c.event("after-revoke");
    await c.shutdown();
    await new Promise((r) => setTimeout(r, 50));
    expect(f.events()).toHaveLength(0);
    expect(c.sessionId()).toBe("");

    c.grantConsent();
    expect(c.sessionId()).not.toBe(id);
  });
});

describe("pending replay keeps the original timestamp", () => {
  it("held_events_are_not_stamped_with_the_replay_time", async () => {
    const f = stubFetch();
    const c = init({ ...cfg, consent: "pending" });
    const t0 = Date.now();
    c.event("old-one");
    await new Promise((r) => setTimeout(r, 60));
    c.grantConsent();
    void c.shutdown();
    await vi.waitFor(() => expect(f.events().length).toBeGreaterThan(0), { timeout: 3000 });
    const ev = f.events().flatMap((x) => bodyOf(x.init).events).find((e: { name: string }) => e.name === "old-one");
    expect(ev.ts_ns / 1e6).toBeLessThan(t0 + 50);
  });
});

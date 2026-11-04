import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { init } from "./index";
import { stubFetch } from "./testutil";

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

import { afterEach, describe, expect, it } from "vitest";
import { setup } from "./harness";
import { RouteGuard } from "./routes";

afterEach(() => history.replaceState({}, "", "/"));

describe("route guard", () => {
  it("matches prefixes and regexps", () => {
    const g = new RouteGuard(["/admin", /^\/u\/\d+\/billing/], () => undefined);
    expect(g.matches("/admin")).toBe(true);
    expect(g.matches("/admin/billing")).toBe(true);
    expect(g.matches("/administrator")).toBe(false);
    expect(g.matches("/u/42/billing")).toBe(true);
  });

  it("replaces excluded URLs in Meta events", () => {
    const g = new RouteGuard(["/admin"], () => undefined);
    const m = { type: 4, timestamp: 1, data: { href: "https://app.test/admin/billing?x=1" } };
    expect(g.rewrite(m).data.href).toBe("[excluded]");
    expect(g.rewrite({ type: 4, timestamp: 1, data: { href: "https://app.test/home" } }).data.href).toContain("/home");
  });

  it("excluded_route_not_recorded", async () => {
    document.body.innerHTML = '<div id="root"><p>public</p></div>';
    const t = setup({ maskLevel: "relaxed", excludeRoutes: ["/admin/billing"] });
    t.h.start();
    history.pushState({}, "", "/admin/billing");
    document.getElementById("root")!.insertAdjacentHTML("beforeend", "<p>invoice-4242-secret</p>");
    await new Promise((r) => setTimeout(r, 50));
    history.pushState({}, "", "/home");
    t.h.stop();
    await t.h.flush();
    expect(t.all()).not.toContain("invoice-4242-secret");
    expect(t.all()).toContain("wt.replay.paused");
    expect(t.all()).not.toContain("billing");
  });
});

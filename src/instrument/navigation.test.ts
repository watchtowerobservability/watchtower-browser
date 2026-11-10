import { afterEach, describe, expect, it } from "vitest";
import { trackRoute } from "../adapters/router";
import { normalizeRoute } from "./ctx";
import { installNavigation, setRoute } from "./navigation";
import { mkCtx } from "./testutil";

let un: (() => void) | undefined;
afterEach(() => {
  un?.();
  setRoute(undefined);
  history.replaceState(null, "", "/");
});

describe("navigation", () => {
  it("route_change_emits_view_with_previous_route", async () => {
    history.replaceState(null, "", "/home");
    const { c, events } = mkCtx();
    const navs: string[] = [];
    un = installNavigation(c, [(n) => navs.push(`${n.previous}>${n.route}`)]);
    window.dispatchEvent(new Event("pagehide")); // the first view waits for a router adapter otherwise
    history.pushState(null, "", "/cart");
    expect(events.map((e) => e.type)).toEqual(["view", "nav"]);
    expect(events[1]!.attrs.previous_route).toBe("/home");
    expect(navs).toEqual(["/home>/cart"]);
    await new Promise((r) => setTimeout(r, 100));
    const v = events.filter((e) => e.type === "view")[1]!;
    expect(v.name).toBe("/cart");
    expect(v.attrs.previous_route).toBe("/home");
    expect(v.attrs.previous_duration_ms).toBeTypeOf("number");
    expect(v.value).toBeGreaterThanOrEqual(0);
  });

  it("same_url_replace_is_not_a_navigation", () => {
    const { c, events } = mkCtx();
    un = installNavigation(c, []);
    history.replaceState(null, "", location.href);
    expect(events.filter((e) => e.type === "nav")).toHaveLength(0);
  });

  it("uninstall_restores_history", () => {
    const orig = history.pushState;
    const { c } = mkCtx();
    installNavigation(c, [])();
    expect(history.pushState).toBe(orig);
  });

  it("route_normalization_replaces_ids", () => {
    expect(normalizeRoute("/users/42/orders/3b241101-e2bb-4255-8caf-4136c566a962?x=1")).toBe("/users/:id/orders/:id");
    expect(normalizeRoute("/a/abcdef0123456789ab")).toBe("/a/:id");
    expect(normalizeRoute("/about")).toBe("/about");
  });

  it("first_load_view_reports_the_adapter_pattern_not_the_concrete_path", () => {
    history.replaceState(null, "", "/gallery/contact");
    const { c, events } = mkCtx();
    un = installNavigation(c, []);
    expect(events).toHaveLength(0); // waits for the hook: it runs after hydration
    trackRoute("/gallery/contact", { typeId: "contact" });
    expect(events.map((e) => [e.type, e.name])).toEqual([["view", "/gallery/:typeId"]]);
    expect(events[0]!.attrs.url).toBe(`${location.origin}/gallery/contact`);
  });

  it("first_load_view_without_an_adapter_falls_back_to_the_path", async () => {
    history.replaceState(null, "", "/about");
    const { c, events } = mkCtx();
    un = installNavigation(c, []);
    await new Promise((r) => setTimeout(r, 400));
    expect(events.map((e) => e.name)).toEqual(["/about"]);
  });

  it("client_navigation_reports_the_pattern_set_after_pushState", () => {
    trackRoute("/gallery/contact", { typeId: "contact" });
    history.replaceState(null, "", "/gallery/contact");
    const { c, events } = mkCtx();
    un = installNavigation(c, []);
    history.pushState(null, "", "/gallery/other"); // the router's effect has not run yet
    expect(events.filter((e) => e.type === "nav")).toHaveLength(0);
    trackRoute("/gallery/other", { typeId: "other" });
    const nav = events.find((e) => e.type === "nav")!;
    expect(nav.name).toBe("/gallery/:typeId");
    expect(nav.attrs.previous_route).toBe("/gallery/:typeId");
  });
});

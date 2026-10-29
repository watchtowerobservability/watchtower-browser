import { afterEach, describe, expect, it } from "vitest";
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
});

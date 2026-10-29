import { describe, expect, it } from "vitest";
import { mkCtx } from "./testutil";
import { rate, vitalAttrs } from "./vitals";

describe("vitals", () => {
  it("vitals_rating_thresholds", () => {
    const cases: Array<[string, number, string]> = [
      ["LCP", 2500, "good"],
      ["LCP", 2501, "needs-improvement"],
      ["LCP", 4001, "poor"],
      ["INP", 200, "good"],
      ["INP", 500, "needs-improvement"],
      ["INP", 501, "poor"],
      ["CLS", 0.1, "good"],
      ["CLS", 0.25, "needs-improvement"],
      ["CLS", 0.26, "poor"],
      ["FCP", 1800, "good"],
      ["FCP", 3001, "poor"],
      ["TTFB", 800, "good"],
      ["TTFB", 1801, "poor"],
    ];
    for (const [n, v, r] of cases) expect(rate(n, v), `${n} ${v}`).toBe(r);
  });

  it("vital_selector_truncated_256", () => {
    const { c } = mkCtx();
    const a = vitalAttrs(
      { name: "LCP", value: 3000, navigationType: "navigate", attribution: { target: "div#" + "x".repeat(400), url: "https://a.test/i.png?t=1" } },
      c,
    );
    expect((a.element as string).length).toBe(256);
    expect(a.url).toBe("https://a.test/i.png");
    expect(a.rating).toBe("needs-improvement");
    expect(a.navigation_type).toBe("navigate");
    expect(a.device_class).toBeTypeOf("string");
  });

  it("inp_carries_interaction_target_and_load_state", () => {
    const { c } = mkCtx();
    const a = vitalAttrs({ name: "INP", value: 100, attribution: { interactionTarget: "button#pay", loadState: "complete" } }, c);
    expect(a).toMatchObject({ interaction_target: "button#pay", load_state: "complete", rating: "good" });
  });
});

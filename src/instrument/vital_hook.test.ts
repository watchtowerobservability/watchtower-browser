import { describe, expect, it, vi } from "vitest";
import type { WtVital } from "../config";
import { mkCtx } from "./testutil";

const cbs: Record<string, (m: unknown) => void> = {};
vi.mock("web-vitals/attribution", () => ({
  onLCP: (f: (m: unknown) => void) => void (cbs.LCP = f),
  onINP: (f: (m: unknown) => void) => void (cbs.INP = f),
  onCLS: (f: (m: unknown) => void) => void (cbs.CLS = f),
  onFCP: (f: (m: unknown) => void) => void (cbs.FCP = f),
  onTTFB: (f: (m: unknown) => void) => void (cbs.TTFB = f),
}));
import { installVitals } from "./vitals";

describe("vital hook", () => {
  it("fires_once_per_vital_when_the_page_is_hidden", async () => {
    const { c } = mkCtx();
    const got: WtVital[] = [];
    c.onVital = (v) => void got.push(v);
    const un = await installVitals(c);
    cbs.LCP!({ name: "LCP", value: 1000 });
    cbs.LCP!({ name: "LCP", value: 3000 });
    cbs.CLS!({ name: "CLS", value: 0.3 });
    expect(got).toHaveLength(0); // interim values are not delivered
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new Event("pagehide"));
    expect(got.map((v) => [v.name, v.value, v.rating, v.final])).toEqual([
      ["LCP", 3000, "needs-improvement", true],
      ["CLS", 0.3, "poor", true],
    ]);
    expect(got[0]!.navigation_id).toBe(got[1]!.navigation_id);
    expect(got[0]!.url).not.toContain("?");
    cbs.LCP!({ name: "LCP", value: 500 });
    window.dispatchEvent(new Event("pagehide"));
    expect(got).toHaveLength(2); // once per page view
    un();
  });
});

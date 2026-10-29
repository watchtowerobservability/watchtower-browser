import { describe, expect, it } from "vitest";
import { makeJourney } from "./journeys";

describe("journeys", () => {
  it("journey_step_failure_event", () => {
    const out: Array<[string, Record<string, unknown>]> = [];
    let t = 1000;
    const j = makeJourney("checkout", (n, a) => out.push([n, a]), () => t);
    t = 1500;
    j.step("payment", { ok: true });
    t = 1700;
    j.fail("card_declined");
    t = 1800;
    j.step("payment");
    expect(out[0]).toEqual(["checkout", { journey: "checkout", step: "payment", ok: true, duration_ms_since_prev: 500, attempt: 1 }]);
    expect(out[1]![1]).toMatchObject({ step: "card_declined", ok: false, duration_ms_since_prev: 200, attempt: 1 });
    expect(out[2]![1]).toMatchObject({ step: "payment", attempt: 2 });
  });
});

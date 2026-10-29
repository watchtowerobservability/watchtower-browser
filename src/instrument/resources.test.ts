import { describe, expect, it } from "vitest";
import { resourceEvent } from "./resources";
import { mkCtx } from "./testutil";

const entry = (name: string, extra = {}) => ({
  name,
  initiatorType: "fetch",
  duration: 12.4,
  transferSize: 900,
  startTime: 1,
  ...extra,
});

describe("resources", () => {
  it("resource_url_query_scrubbed", () => {
    const { c } = mkCtx();
    const r = resourceEvent(entry("https://api.x.test/v1/o?token=abc#frag"), c)!;
    expect(r.attrs!.url).toBe("https://api.x.test/v1/o");
    expect(JSON.stringify(r)).not.toContain("abc");
    expect(r.value).toBe(12);
  });

  it("status_and_trace_id_come_from_fetch_instrumentation", () => {
    const { c } = mkCtx();
    c.net.set("https://api.x.test/v1/o", { status: 502, trace_id: "a".repeat(32) });
    const r = resourceEvent(entry("https://api.x.test/v1/o?x=1"), c)!;
    expect(r.attrs).toMatchObject({ status: 502, failed: true });
    expect(r.trace_id).toBe("a".repeat(32));
  });

  it("sdk_does_not_instrument_its_own_requests", () => {
    const { c } = mkCtx();
    expect(resourceEvent(entry("https://edge.test/v1/rum/events"), c)).toBeNull();
    expect(resourceEvent(entry("https://otlp.test/v1/traces"), c)).toBeNull();
    expect(resourceEvent(entry("data:image/png;base64,AAAA"), c)).toBeNull();
  });
});

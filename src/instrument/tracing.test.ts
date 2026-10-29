import { ROOT_CONTEXT, trace, type Span } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { makePropagator } from "./tracing";
import { baseCfg, mkCtx } from "./testutil";

/** Run the propagator the way the fetch instrumentation does: span in context, carrier = headers. */
function inject(url: string, propagateTo?: Array<string | RegExp>): Record<string, string> {
  const { c } = mkCtx({ propagateTo });
  const span = {
    spanContext: () => ({ traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 }),
    attributes: { "http.url": url },
  } as unknown as Span;
  const carrier: Record<string, string> = {};
  makePropagator(c.cfg, c.isOwn).inject(trace.setSpan(ROOT_CONTEXT, span), carrier, {
    set: (cr: Record<string, string>, k, v) => void (cr[k] = v),
  });
  return carrier;
}

describe("traceparent", () => {
  it("traceparent_not_sent_to_unlisted_origin", () => {
    const allow = ["https://api.mine.test"];
    expect(inject("https://api.other.com/v1/x", allow).traceparent).toBeUndefined();
    expect(inject("https://api.mine.test/v1/x", allow).traceparent).toBe(`00-${"a".repeat(32)}-${"b".repeat(16)}-01`);
    // never into Watchtower's own endpoints, even when a matcher would cover them
    expect(inject(`${baseCfg.endpoint}/v1/rum/events`, [/.*/]).traceparent).toBeUndefined();
    expect(inject(`${baseCfg.otlpEndpoint}/v1/traces`, ["https://"]).traceparent).toBeUndefined();
  });

  it("traceparent_not_sent_same_origin_by_default", () => {
    expect(inject(`${location.origin}/api/orders`).traceparent).toBeUndefined();
    expect(inject(`${location.origin}/api/orders`, []).traceparent).toBeUndefined();
    expect(inject(`${location.origin}/api/orders`, [location.origin]).traceparent).toBeDefined();
  });

  it("no_url_means_no_header", () => {
    expect(inject("", [/.*/]).traceparent).toBeUndefined();
  });
});

import { context, trace } from "@opentelemetry/api";
import { WebTracerProvider, type Span } from "@opentelemetry/sdk-trace-web";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ACTION_IDLE_MS, ActionContextManager, installUserActions } from "./actions";
import { mkCtx } from "./testutil";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("click_opens_action_that_parents_fetch_spans", () => {
  const cm = new ActionContextManager();
  let ua: ReturnType<typeof installUserActions> | undefined;
  const provider = new WebTracerProvider({
    spanProcessors: [{ onStart: (s, p) => ua?.onStart(s as unknown as Span, p), onEnd: (s) => ua?.onEnd(s as unknown as Span),
      forceFlush: () => Promise.resolve(), shutdown: () => Promise.resolve() }],
  });
  context.setGlobalContextManager(cm);
  const tracer = provider.getTracer("t");
  const { c, events } = mkCtx();
  ua = installUserActions(c, tracer, cm);
  const btn = document.createElement("button");
  btn.setAttribute("data-wt-action", "checkout");
  document.body.appendChild(btn);
  btn.click();
  const child = tracer.startSpan("GET /api/cart"); // what the fetch instrumentation does, no context passed
  const action = trace.getSpan(cm.active())!;
  expect((child as unknown as { parentSpanContext?: { spanId: string } }).parentSpanContext?.spanId).toBe(action.spanContext().spanId);
  vi.advanceTimersByTime(ACTION_IDLE_MS * 3);
  expect(events).toHaveLength(0); // still waiting for the child
  child.end();
  vi.advanceTimersByTime(ACTION_IDLE_MS + 1);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: "action", name: "checkout", attrs: { "user_action.type": "click", "user_action.children": 1 } });
  expect(events[0]!.trace_id).toBe(action.spanContext().traceId);
  expect(cm.action).toBeUndefined();
  ua.uninstall();
  context.disable();
  btn.remove();
});

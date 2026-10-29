import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installErrors, parseStack } from "./errors";
import { mkCtx } from "./testutil";

const V8_STACK = `TypeError: x is undefined
    at inner (https://cdn.x.test/app.js:10:5)
    at async outer (https://cdn.x.test/app.js:20:7)
    at https://cdn.x.test/app.js:30:1`;

let un: (() => void) | undefined;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  un?.();
  vi.useRealTimers();
  delete (window as any)._wtDebugIds;
});

function throwErr(stack = V8_STACK, message = "x is undefined") {
  const error = Object.assign(new TypeError(message), { stack });
  window.dispatchEvent(new ErrorEvent("error", { error, message }));
}

describe("errors", () => {
  it("error_event_has_frames_and_debug_ids", () => {
    (window as any)._wtDebugIds = { "https://cdn.x.test/app.js": "11111111-2222-3333-4444-555555555555", "other.js": "z" };
    const { c, events } = mkCtx();
    un = installErrors(c);
    throwErr();
    const e = events[0]!;
    expect(e.type).toBe("error");
    expect(e.name).toBe("TypeError");
    const frames = JSON.parse(e.attrs.frames as string);
    expect(frames).toHaveLength(3);
    // oldest first: the innermost frame is last
    expect(frames[2]).toEqual({ function: "inner", filename: "https://cdn.x.test/app.js", lineno: 10, colno: 5 });
    expect(JSON.parse(e.attrs.debug_ids as string)).toEqual({
      "https://cdn.x.test/app.js": "11111111-2222-3333-4444-555555555555",
    });
    expect(e.attrs).toMatchObject({ type: "TypeError", handled: false, mechanism: "onerror", release: "r1" });
  });

  it("parses_gecko_frames", () => {
    expect(parseStack("f@https://a.test/x.js:3:4\n@https://a.test/y.js:5:6")).toEqual([
      { function: "?", filename: "https://a.test/y.js", lineno: 5, colno: 6 },
      { function: "f", filename: "https://a.test/x.js", lineno: 3, colno: 4 },
    ]);
  });

  it("unhandled_rejection_captured", () => {
    const { c, events } = mkCtx();
    un = installErrors(c);
    const ev = new Event("unhandledrejection");
    Object.assign(ev, { reason: new RangeError("boom") });
    window.dispatchEvent(ev);
    expect(events[0]!.attrs).toMatchObject({ type: "RangeError", message: "boom", mechanism: "unhandledrejection" });
  });

  it("duplicate_error_within_5s_dropped", () => {
    const { c, events } = mkCtx();
    un = installErrors(c);
    throwErr();
    throwErr();
    expect(events).toHaveLength(1);
    vi.advanceTimersByTime(5001);
    throwErr();
    expect(events).toHaveLength(2);
  });

  it("resource_load_failure_captured_without_query", () => {
    const { c, events } = mkCtx();
    un = installErrors(c);
    const img = document.createElement("img");
    img.src = "https://cdn.x.test/a.png?token=secret";
    document.body.appendChild(img);
    img.dispatchEvent(new Event("error"));
    expect(events[0]!.attrs.message).toBe("Failed to load img https://cdn.x.test/a.png");
  });

  it("console_error_off_by_default", () => {
    const { c, events } = mkCtx();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    un = installErrors(c);
    console.error("x");
    expect(events).toHaveLength(0);
    spy.mockRestore();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFrustration } from "./frustration";
import { mkCtx } from "./testutil";

let un: (() => void) | undefined;
let btn: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = `<button id="pay" class="btn" data-testid="pay">Secret card 4242</button><div id="plain">x</div>`;
  btn = document.getElementById("pay")!;
});
afterEach(() => {
  un?.();
  vi.useRealTimers();
});

const click = (el: Element, x = 10, y = 10) =>
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y }));
const kinds = (events: Array<{ attrs: Record<string, unknown> }>) => events.map((e) => e.attrs.kind);

describe("frustration", () => {
  it("rage_click_detected_at_3_in_1s", () => {
    const { c, events } = mkCtx();
    un = installFrustration(c);
    const el = document.getElementById("plain")!;
    click(el);
    vi.advanceTimersByTime(300);
    click(el, 20, 20);
    vi.advanceTimersByTime(300);
    click(el, 30, 15);
    expect(kinds(events)).toEqual(["rage_click"]);
    expect(events[0]!.attrs).toMatchObject({ count: 3, selector: "div#plain", x: 30, y: 15 });
  });

  it("two_clicks_not_rage", () => {
    const { c, events } = mkCtx();
    un = installFrustration(c);
    const el = document.getElementById("plain")!;
    click(el);
    click(el);
    expect(events).toHaveLength(0);
    vi.advanceTimersByTime(1500);
    click(el); // the first two are older than 1 s
    expect(events).toHaveLength(0);
  });

  it("dead_click_requires_no_mutation", async () => {
    const { c, events } = mkCtx();
    un = installFrustration(c);
    click(btn);
    vi.advanceTimersByTime(1000);
    expect(kinds(events)).toEqual(["dead_click"]);

    events.length = 0;
    click(btn);
    document.body.appendChild(document.createElement("span")); // DOM reacts
    await vi.advanceTimersByTimeAsync(0); // let the MutationObserver callback run
    vi.advanceTimersByTime(1000);
    expect(events).toHaveLength(0);
  });

  it("error_click_within_1s", () => {
    const { c, events } = mkCtx();
    un = installFrustration(c);
    click(btn);
    window.dispatchEvent(new ErrorEvent("error", { message: "boom", error: new Error("boom") }));
    expect(kinds(events)).toContain("error_click");
    events.length = 0;
    vi.advanceTimersByTime(2000);
    window.dispatchEvent(new ErrorEvent("error", { message: "late" }));
    expect(kinds(events)).not.toContain("error_click");
  });

  it("frustration_event_has_no_text", () => {
    const { c, events } = mkCtx();
    un = installFrustration(c);
    click(btn);
    vi.advanceTimersByTime(1000);
    const e = events[0]!;
    expect(e.attrs.selector).toBe("button#pay.btn[data-testid=pay]");
    expect(JSON.stringify(e)).not.toMatch(/Secret|4242/);
  });
});

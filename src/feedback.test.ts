import { afterEach, describe, expect, it, vi } from "vitest";
import { feedbackBody, mountWidget, sendFeedback, validShot, type FeedbackCtx } from "./feedback";

const ctx = (over: Partial<FeedbackCtx> = {}): FeedbackCtx => ({
  endpoint: "https://e.test/", key: "pk_1", sessionId: () => "s-1",
  lastErrorId: () => "0123456789ab4def8123456789abcdef".replace(/^(.{8})(.{4})(.{4})(.{4})/, "$1-$2-$3-$4-"),
  flushReplay: () => Promise.resolve(), ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("feedback", () => {
  it("feedback_body_links_the_last_error_and_trims", () => {
    const b = feedbackBody({ message: "  broken  ", email: " a@x.io " }, "0123456789ab-4def-8123-456789abcdef");
    expect(b).toEqual({ message: "broken", email: "a@x.io", event_id: "0123456789ab4def8123456789abcdef" });
    expect(feedbackBody({ message: "x", eventId: "not-hex" }, undefined)).toEqual({ message: "x" });
    expect(feedbackBody({ message: "   " }, undefined)).toBeNull();
    expect(validShot("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    expect(validShot("data:image/gif;base64,AAAA")).toBeUndefined();
    expect(validShot("data:image/png;base64," + "A".repeat(6 << 20))).toBeUndefined();
  });

  it("send_feedback_posts_message_then_screenshot_report", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return Promise.resolve(new Response(null, { status: 202 }));
    }));
    const flush = vi.fn(() => Promise.resolve());
    const ok = await sendFeedback(ctx({ flushReplay: flush }), { message: "hi", screenshot: "data:image/jpeg;base64,AAAA" });
    expect(ok).toBe(true);
    expect(calls.map((c) => c.url)).toEqual(["https://e.test/v1/rum/feedback", "https://e.test/v1/rum/bug-reports"]);
    expect(calls[0]!.body.event_id).toBe("0123456789ab4def8123456789abcdef");
    expect(calls[1]!.body.session_id).toBe("s-1");
    expect(flush).toHaveBeenCalled();
    expect(await sendFeedback(ctx(), { message: "" })).toBe(false);
  });

  it("send_feedback_never_throws", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    expect(await sendFeedback(ctx(), { message: "hi" })).toBe(false);
  });

  it("widget_mounts_opens_and_removes", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 202 })));
    vi.stubGlobal("fetch", fetchMock);
    const w = mountWidget(ctx(), { label: "Tell us", screenshot: false });
    const button = document.querySelector<HTMLButtonElement>("[data-watchtower=feedback-button]")!;
    expect(button.textContent).toBe("Tell us");
    w.open(true);
    const dialog = document.querySelector("dialog[data-watchtower=feedback]")!;
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(dialog.textContent).toContain("something went wrong");
    dialog.querySelector("textarea")!.value = "it crashed";
    dialog.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    w.remove();
    expect(document.querySelector("[data-watchtower]")).toBeNull();
  });
});

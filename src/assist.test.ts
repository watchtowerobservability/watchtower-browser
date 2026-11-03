import { afterEach, describe, expect, it, vi } from "vitest";
import { maskRules, run, safeTarget, startAssist } from "./assist";

const relaxed = { strict: false };
const html = (s: string): HTMLElement => {
  document.body.innerHTML = s;
  return document.body;
};

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("assist", () => {
  it("assist_never_targets_inputs_masked_or_its_own_ui", () => {
    const b = html(`<button id="ok">Go</button><input id="pw" type="password"><input id="cc" autocomplete="cc-number">
      <label id="lb">x <span id="in">y</span></label><div contenteditable id="ce">t</div>
      <div class="wt-mask"><a id="m">m</a></div><div data-wt-block><a id="bl">b</a></div>
      <div data-wt-assist-ui><button id="ui">Allow</button></div><p data-wt-unmask><a id="un">u</a></p>`);
    const q = (id: string) => b.querySelector(`#${id}`);
    expect(safeTarget(q("ok"), relaxed)).toBe(q("ok"));
    for (const id of ["pw", "cc", "lb", "in", "ce", "m", "bl", "ui"]) expect(safeTarget(q(id), relaxed)).toBeNull();
    // strict masks all text: only explicitly unmasked parts may be clicked
    expect(safeTarget(q("ok"), { strict: true })).toBeNull();
    expect(safeTarget(q("un"), { strict: true })).toBe(q("un"));
    expect(maskRules(undefined, undefined).strict).toBe(true); // the default level is strict
  });

  it("assist_click_runs_on_safe_elements_only", () => {
    const b = html(`<button id="ok">Go</button><input id="t">`);
    const ok = b.querySelector("#ok")!;
    const input = b.querySelector("#t")!;
    const clicked = vi.fn();
    ok.addEventListener("click", clicked);
    const focus = vi.spyOn(input as HTMLInputElement, "focus");
    document.elementFromPoint = () => ok;
    expect(run({ seq: 1, kind: "click", x: 0.5, y: 0.5, dx: 0, dy: 0 }, relaxed)).toBe(true);
    expect(clicked).toHaveBeenCalledTimes(1);
    document.elementFromPoint = () => input;
    expect(run({ seq: 2, kind: "click", x: 0.5, y: 0.5, dx: 0, dy: 0 }, relaxed)).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    expect(run({ seq: 3, kind: "click", x: 2, y: 0.5, dx: 0, dy: 0 }, relaxed)).toBe(false);
  });

  it("assist_prompt_needs_a_real_click_and_404_stops_polling", async () => {
    const calls: string[] = [];
    let pending = true;
    const f = vi.fn(async (u: string | URL | Request) => {
      const url = String(u);
      calls.push(url);
      if (url.includes("/accept")) return new Response(JSON.stringify({ channel: "c" }), { status: 200 });
      if (!pending) return new Response("", { status: 404 });
      return new Response(JSON.stringify({ id: "a1", token: "t1" }), { status: 200 });
    }) as unknown as typeof fetch;
    const startReplay = vi.fn();
    const h = startAssist({ cfg: { enabled: true }, endpoint: "https://e/", key: "k", sessionId: () => "s1", startReplay, mask: () => relaxed, f });
    await vi.waitFor(() => expect(document.querySelector("[role=dialog]")).not.toBeNull());
    expect(calls[0]).toBe("https://e/v1/rum/assist?session=s1");
    // a synthetic click (what a remote command would produce) does not accept
    (document.querySelector("[role=dialog] button") as HTMLButtonElement).click();
    await Promise.resolve();
    expect(calls.some((c) => c.includes("/accept"))).toBe(false);
    expect(startReplay).not.toHaveBeenCalled();
    h.stop();
    expect(document.querySelector("[data-wt-assist-ui]")).toBeNull();

    pending = false;
    calls.length = 0;
    vi.useFakeTimers();
    const h2 = startAssist({ cfg: { enabled: true, pollMs: 10 }, endpoint: "https://e", key: "k", sessionId: () => "s1", startReplay, mask: () => relaxed, f });
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(1); // project has assist off: no more polls
    h2.stop();
  });
});

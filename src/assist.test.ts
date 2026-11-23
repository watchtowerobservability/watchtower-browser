import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTROL_IDLE_MS, CONTROL_MAX_MS, limiter, maskRules, run, safeTarget, startAssist, typable, validate, type Command } from "./assist.js";

const relaxed = { strict: false };
const html = (s: string): HTMLElement => {
  document.body.innerHTML = s;
  return document.body;
};

/** The prompt and banner live in shadow roots: find an element in any of them. */
const ui = (sel: string): HTMLElement | null => {
  for (const h of document.querySelectorAll("[data-wt-assist-ui]")) {
    const e = h.shadowRoot?.querySelector<HTMLElement>(sel);
    if (e) return e;
  }
  return null;
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
    await vi.waitFor(() => expect(ui("[role=dialog]")).not.toBeNull());
    expect(calls[0]).toBe("https://e/v1/rum/assist?session=s1");
    // a synthetic click (what a remote command would produce) does not accept
    ui("[role=dialog] button")!.click();
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

const cmd = (o: Partial<Command>): Command => ({ seq: 1, kind: "click", x: 0.5, y: 0.5, dx: 0, dy: 0, ...o });

describe("assist remote control", () => {
  it("control_commands_are_a_closed_validated_set", () => {
    expect(validate({ seq: 1, kind: "click", x: 0.1, y: 0.2, dx: 0, dy: 0, node: 5 })).not.toBeNull();
    for (const kind of ["navigate", "eval", "paste", "upload", "key", "value"]) {
      expect(validate({ seq: 1, kind, x: 0, y: 0, dx: 0, dy: 0 })).toBeNull();
    }
    expect(validate({ kind: "click", x: 2, y: 0, dx: 0, dy: 0 })).toBeNull();
    expect(validate({ kind: "click", x: 0, y: 0, dx: 9000, dy: 0 })).toBeNull();
    expect(validate({ kind: "click", x: 0, y: 0, dx: 0, dy: 0, node: -1 })).toBeNull();
    expect(validate({ kind: "click", x: 0, y: 0, dx: 0, dy: 0, node: 1.5 })).toBeNull();
    expect(validate({ kind: "type", x: 0, y: 0, dx: 0, dy: 0, text: "hi" })).toBeNull(); // no node
    expect(validate({ kind: "type", x: 0, y: 0, dx: 0, dy: 0, node: 3, text: "a\nb" })).toBeNull();
    expect(validate({ kind: "type", x: 0, y: 0, dx: 0, dy: 0, node: 3, text: "a".repeat(201) })).toBeNull();
    expect(validate({ kind: "type", x: 0, y: 0, dx: 0, dy: 0, node: 3, text: "ok" })).not.toBeNull();
    expect(validate(null)).toBeNull();
  });

  it("typing_only_into_plain_unmasked_fields", () => {
    const b = html(`<input id="t"><input id="pw" type="password"><input id="cc" autocomplete="cc-number"><input id="file" type="file">
      <input id="cvv" name="cvv"><input id="ro" readonly><input id="mk" data-wt-mask><div class="wt-mask"><input id="in"></div>
      <textarea id="ta"></textarea><button id="bt">x</button><input id="cb" type="checkbox"><input id="otp" autocomplete="one-time-code">`);
    const q = (id: string) => b.querySelector(`#${id}`);
    expect(typable(q("t"), relaxed)).toBe(q("t"));
    expect(typable(q("ta"), relaxed)).toBe(q("ta"));
    for (const id of ["pw", "cc", "file", "cvv", "ro", "mk", "in", "bt", "cb", "otp"]) expect(typable(q(id), relaxed)).toBeNull();
    expect(typable(q("t"), { strict: true })).toBeNull(); // strict mode masks every input
  });

  it("type_by_replay_node_fills_the_field_and_refuses_masked_ones", () => {
    const b = html(`<input id="t"><input id="pw" type="password"><div data-wt-mask><input id="m"></div>`);
    const nodes: Record<number, Node> = { 1: b.querySelector("#t")!, 2: b.querySelector("#pw")!, 3: b.querySelector("#m")! };
    const resolve = (id: number) => nodes[id] ?? null;
    const input = vi.fn();
    b.addEventListener("input", input);
    expect(run(cmd({ kind: "type", node: 1, text: "hello" }), relaxed, document, resolve)).toBe(true);
    expect((nodes[1] as HTMLInputElement).value).toBe("hello");
    expect(input).toHaveBeenCalledTimes(1);
    expect(run(cmd({ kind: "type", node: 2, text: "x" }), relaxed, document, resolve)).toBe(false);
    expect(run(cmd({ kind: "type", node: 3, text: "x" }), relaxed, document, resolve)).toBe(false);
    expect(run(cmd({ kind: "type", node: 99, text: "x" }), relaxed, document, resolve)).toBe(false); // unknown node: no fallback
    expect((nodes[2] as HTMLInputElement).value).toBe("");
    // a node that is not a text field is not typable even when it resolves
    expect(run(cmd({ kind: "type", node: 1, text: "" }), relaxed, document, resolve)).toBe(false);
  });

  it("click_and_highlight_resolve_by_node_not_coordinates", () => {
    const b = html(`<button id="a">A</button><button id="b" class="wt-block">B</button>`);
    const a = b.querySelector("#a")!;
    const bb = b.querySelector("#b")!;
    const clicked = vi.fn();
    a.addEventListener("click", clicked);
    document.elementFromPoint = () => bb; // coordinates would hit the blocked button
    const resolve = (id: number) => (id === 1 ? a : id === 2 ? bb : null);
    expect(run(cmd({ node: 1 }), relaxed, document, resolve)).toBe(true);
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(run(cmd({ node: 2 }), relaxed, document, resolve)).toBe(false);
    expect(run(cmd({ kind: "highlight", node: 1, text: "here" }), relaxed, document, resolve)).toBe(true);
    expect(document.querySelectorAll("[data-wt-assist-ui]").length).toBe(1);
    expect(run(cmd({ kind: "move", node: 2 }), relaxed, document, resolve)).toBe(false);
  });

  it("rate_limit_is_ten_per_second", () => {
    let t = 0;
    const ok = limiter(() => t);
    const n = Array.from({ length: 12 }, () => ok()).filter(Boolean).length;
    expect(n).toBe(10);
    t = 1001;
    expect(ok()).toBe(true);
  });

  /** An accepted assist polled every 10 ms with scripted answers; clicks count as the user's own. */
  async function live(o: { allowControl: boolean; control: () => string; commands: () => unknown[]; clock: { t: number } }) {
    const posts: string[] = [];
    const f = vi.fn(async (u: string | URL | Request, init?: RequestInit) => {
      const url = String(u);
      posts.push(`${url.split("/assist")[1] ?? ""} ${init?.body ?? ""}`);
      if (url.endsWith("/accept")) return new Response(JSON.stringify({ channel: "c" }), { status: 200 });
      if (url.endsWith("/poll")) return new Response(JSON.stringify({ state: "active", control: o.control(), commands: o.commands() }), { status: 200 });
      if (url.includes("assist?")) return new Response(JSON.stringify({ id: "a1", token: "t" }), { status: 200 });
      return new Response("", { status: 204 });
    }) as unknown as typeof fetch;
    const b = html(`<button id="ok">Go</button>`);
    const clicked = vi.fn();
    b.querySelector("#ok")!.addEventListener("click", clicked);
    const h = startAssist({
      cfg: { enabled: true, allowControl: o.allowControl, pollMs: 10 }, endpoint: "https://e", key: "k", sessionId: () => "s1",
      startReplay: () => undefined, mask: () => relaxed, resolve: () => b.querySelector("#ok"), f, now: () => o.clock.t, trusted: () => true,
    });
    await vi.advanceTimersByTimeAsync(20);
    ui("[role=dialog] button")!.click(); // accept the assist
    await vi.advanceTimersByTimeAsync(10);
    return { h, posts, clicked, wrote: (frag: string) => posts.some((p) => p.includes(frag)) };
  }
  const click1 = [{ seq: 1, kind: "click", x: 0.5, y: 0.5, dx: 0, dy: 0, node: 1 }];

  it("control_is_refused_without_the_option_and_never_prompts", async () => {
    vi.useFakeTimers();
    const clock = { t: 0 };
    const s = await live({ allowControl: false, control: () => "requested", commands: () => click1, clock });
    await vi.advanceTimersByTimeAsync(5000);
    expect(ui("[role=dialog]")).toBeNull();
    expect(s.wrote('"grant":false')).toBe(true);
    expect(s.clicked).not.toHaveBeenCalled();
    s.h.stop();
  });

  it("control_needs_the_users_allow_and_a_server_grant_alone_is_withdrawn", async () => {
    vi.useFakeTimers();
    const clock = { t: 0 };
    const s = await live({ allowControl: true, control: () => "granted", commands: () => click1, clock });
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.clicked).not.toHaveBeenCalled(); // the user never allowed it
    expect(s.wrote('"grant":false')).toBe(true);
    s.h.stop();
  });

  it("control_runs_after_allow_then_stops_on_expiry_and_on_the_stop_button", async () => {
    vi.useFakeTimers();
    const clock = { t: 0 };
    let control = "requested";
    const s = await live({ allowControl: true, control: () => control, commands: () => click1, clock });
    await vi.advanceTimersByTimeAsync(2100);
    expect(ui("[role=dialog]")).not.toBeNull(); // the second consent prompt
    ui("[role=dialog] button")!.click(); // Allow control
    control = "granted";
    await vi.advanceTimersByTimeAsync(2100);
    expect(s.clicked).toHaveBeenCalled();
    expect(ui("[role=status]")!.textContent).toContain("Support is controlling this page");
    // idle for more than two minutes: control ends in the page
    const n = s.clicked.mock.calls.length;
    clock.t = CONTROL_IDLE_MS + 5000;
    await vi.advanceTimersByTimeAsync(2100);
    expect(s.wrote('"grant":false')).toBe(true);
    expect(s.clicked.mock.calls.length).toBe(n);
    expect(ui("[role=status]")!.textContent).not.toContain("controlling");
    s.h.stop();
  });

  it("stop_button_takes_control_back", async () => {
    vi.useFakeTimers();
    const clock = { t: 0 };
    let control = "requested";
    const s = await live({ allowControl: true, control: () => control, commands: () => [], clock });
    await vi.advanceTimersByTimeAsync(2100);
    ui("[role=dialog] button")!.click();
    control = "granted";
    await vi.advanceTimersByTimeAsync(2100);
    const stop = [...document.querySelectorAll("[data-wt-assist-ui]")].map((h) => h.shadowRoot?.querySelector("[role=status] button")).find(Boolean) as HTMLElement;
    expect(stop.textContent).toBe("Stop");
    stop.click();
    expect(s.wrote('"grant":false')).toBe(true);
    expect(ui("[role=status]")!.textContent).not.toContain("controlling");
    s.h.stop();
  });

  it("control_lasts_fifteen_minutes_with_two_idle_minutes", () => {
    expect(CONTROL_MAX_MS).toBe(15 * 60_000);
    expect(CONTROL_IDLE_MS).toBe(2 * 60_000);
  });
});

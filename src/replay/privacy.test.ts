import { afterEach, describe, expect, it } from "vitest";
import type { MaskLevel } from "./config";
import { setup } from "./harness";
import { buildRecordOptions, Sanitizer, unmaskReport } from "./privacy";

afterEach(() => {
  document.body.innerHTML = "";
});

const typeInto = (id: string, v: string): void => {
  const el = document.getElementById(id) as HTMLInputElement;
  el.value = v;
  el.dispatchEvent(new Event("input", { bubbles: true }));
};

describe("sanitizer (belt and braces)", () => {
  const snap = (attrs: Record<string, string>) => ({
    type: 2,
    timestamp: 1,
    data: { node: { id: 1, type: 2, tagName: "input", attributes: attrs, childNodes: [] } },
  });

  it("blanks password, cc-* and one-time-code values and their later input events", () => {
    const s = new Sanitizer();
    for (const [i, attrs] of [{ type: "password" }, { autocomplete: "cc-number" }, { autocomplete: "one-time-code" }].entries()) {
      const e = snap({ ...attrs, value: "hunter2-secret" });
      e.data.node.id = i + 10;
      s.apply(e);
      expect(JSON.stringify(e)).not.toContain("hunter2-secret");
      const inp = { type: 3, timestamp: 2, data: { source: 5, id: i + 10, text: "hunter2-secret" } };
      s.apply(inp);
      expect(inp.data.text).toBe("*");
    }
  });

  it("blanks mutation adds and attribute changes for sensitive nodes", () => {
    const s = new Sanitizer();
    const add = {
      type: 3, timestamp: 1,
      data: { source: 0, adds: [{ node: { id: 5, type: 2, tagName: "input", attributes: { type: "password", value: "hunter2-secret" }, childNodes: [] } }], attributes: [], texts: [] },
    };
    s.apply(add);
    const attr = { type: 3, timestamp: 2, data: { source: 0, adds: [], texts: [], attributes: [{ id: 5, attributes: { value: "hunter2-secret" } }] } };
    s.apply(attr);
    expect(JSON.stringify([add, attr])).not.toContain("hunter2-secret");
  });

  it("leaves ordinary inputs alone", () => {
    const e = snap({ type: "text", value: "visible" });
    new Sanitizer().apply(e);
    expect(JSON.stringify(e)).toContain("visible");
  });
});

describe("record options", () => {
  it("ignores hostile maskAllInputs and keeps masking classes fixed", () => {
    const o = buildRecordOptions({ maskAllInputs: false, blockClass: "x" } as any, "relaxed");
    expect(o.maskAllInputs).toBe(true);
    expect(o.blockClass).toBe("wt-block");
    expect((o.maskInputFn as (s: string) => string)("abcd")).toBe("****");
  });

  it("canvas_off_in_strict_even_if_requested", () => {
    expect(buildRecordOptions({ recordCanvas: true }, "strict").recordCanvas).toBe(false);
    expect(buildRecordOptions({ recordCanvas: true }, "balanced").recordCanvas).toBe(true);
    expect(buildRecordOptions({}, "relaxed").recordCanvas).toBe(false);
  });

  it("strict masks all text except data-wt-unmask; relaxed only [data-wt-mask]", () => {
    expect(buildRecordOptions({}, "strict").maskTextSelector).toBe("*");
    expect(buildRecordOptions({ maskTextSelector: ".pii" }, "relaxed").maskTextSelector).toBe("[data-wt-mask], .pii");
    document.body.innerHTML = '<p id="u" data-wt-unmask>Alice</p><p id="m">Alice</p>';
    const fn = buildRecordOptions({}, "strict").maskTextFn as (t: string, e: Element) => string;
    expect(fn("Alice 42", document.getElementById("u")!)).toBe("Alice 42");
    expect(fn("Alice 42", document.getElementById("m")!)).toBe("***** **");
  });
});

describe("recorder end to end (rrweb in happy-dom)", () => {
  it("password_input_never_in_payload", async () => {
    for (const lvl of ["strict", "balanced", "relaxed"] as MaskLevel[]) {
      // hostile config: maskAllInputs=false must have no effect
      document.body.innerHTML = '<input id="p" type="password" value=""><input id="c" autocomplete="cc-number">';
      const t = setup({ maskLevel: lvl, maskAllInputs: false } as any);
      t.h.start();
      typeInto("p", "hunter2-secret");
      typeInto("c", "4242424242424242");
      t.h.stop();
      await t.h.flush();
      expect(t.all()).not.toContain("hunter2-secret");
      expect(t.all()).not.toContain("4242424242424242");
    }
  });

  it("credit_card_autocomplete_masked_even_relaxed", async () => {
    document.body.innerHTML = '<input id="c" autocomplete="cc-number" value="4242424242424242">';
    const t = setup({ maskLevel: "relaxed" });
    t.h.start();
    typeInto("c", "4111111111111111");
    t.h.stop();
    await t.h.flush();
    expect(t.all()).not.toMatch(/4242424242424242|4111111111111111/);
  });

  it("text_masked_strict_by_default", async () => {
    for (const [lvl, visible] of [["strict", false], ["relaxed", true]] as const) {
      document.body.innerHTML = '<p>Alice Account 4242</p><p data-wt-mask>Bob Secret 99</p>';
      const t = setup({ maskLevel: lvl });
      t.h.start();
      t.h.stop();
      await t.h.flush();
      expect(t.all().includes("Alice Account 4242")).toBe(visible);
      expect(t.all()).not.toContain("Bob Secret 99");
    }
  });

  it("unmask_selector_ignored_in_strict_for_inputs", async () => {
    document.body.innerHTML = '<div class="ok"><input id="t" type="text"></div>';
    const t = setup({ maskLevel: "strict", unmaskSelector: ".ok" });
    t.h.start();
    typeInto("t", "plain-typed-value");
    t.h.stop();
    await t.h.flush();
    expect(t.all()).not.toContain("plain-typed-value");
  });

  it("wt_block_element_not_in_snapshot", async () => {
    document.body.innerHTML = '<div class="wt-block">blocked-content</div><div data-wt-block>blocked-attr</div>';
    const t = setup({ maskLevel: "relaxed" });
    t.h.start();
    t.h.stop();
    await t.h.flush();
    expect(t.all()).not.toContain("blocked-content");
    expect(t.all()).not.toContain("blocked-attr");
  });
});

describe("framework fixtures", () => {
  // Markup shapes the common frameworks emit (hydration markers, directives, scoped classes).
  const fixtures: Record<string, string> = {
    react: '<div id="root" data-reactroot=""><label>Name <input id="f" type="text" value=""></label><p>Jane Roe 555-0100</p></div>',
    vue: '<div id="app" data-v-app=""><input id="f" v-model="name" data-v-7ba5bd90 type="text"><p data-v-7ba5bd90>Jane Roe 555-0100</p></div>',
    angular: '<app-root ng-version="17.0.0"><input id="f" ng-reflect-model="x" type="text"><p _ngcontent-abc>Jane Roe 555-0100</p></app-root>',
    svelte: '<main class="svelte-1abcd"><input id="f" class="svelte-1abcd" type="text"><p class="svelte-1abcd">Jane Roe 555-0100</p></main>',
    next: '<div id="__next"><input id="f" type="text"><p>Jane Roe 555-0100</p><input id="pw" type="password" value=""></div>',
  };

  it("masks_across_framework_fixtures", async () => {
    for (const [name, html] of Object.entries(fixtures)) {
      document.body.innerHTML = html;
      const t = setup({ maskLevel: "strict" });
      t.h.start();
      typeInto("f", `typed-secret-${name}`);
      if (document.getElementById("pw")) typeInto("pw", "pw-secret-9");
      t.h.stop();
      await t.h.flush();
      expect(t.all(), name).not.toContain("Jane Roe");
      expect(t.all(), name).not.toContain("555-0100");
      expect(t.all(), name).not.toContain(`typed-secret-${name}`);
      expect(t.all(), name).not.toContain("pw-secret-9");
    }
  });

  it("unmask_allowlist_report_lists_exemptions", () => {
    document.body.innerHTML = '<p data-wt-unmask>a</p><p data-wt-unmask>b</p><span class="ok">c</span>';
    expect(unmaskReport(document, { unmaskSelector: ".ok" })).toEqual([
      { selector: "[data-wt-unmask]", count: 2 },
      { selector: ".ok", count: 1 },
    ]);
    expect(unmaskReport(document, {})).toHaveLength(1);
  });
});

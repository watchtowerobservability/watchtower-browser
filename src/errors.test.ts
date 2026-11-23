import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

it("errors_entry_under_2_5kib_gz", async () => {
  const r = await build({ entryPoints: ["src/errors.ts"], bundle: true, minify: true, format: "esm", target: "es2020", write: false });
  expect(gzipSync(r.outputFiles[0]!.contents, { level: 9 }).length).toBeLessThan(2560);
});

it("errors_sends_simple_post_dedupes_caps_stores_nothing_and_hands_off", async () => {
  vi.resetModules();
  const calls: Array<[string, RequestInit]> = [];
  vi.stubGlobal("fetch", vi.fn(async (u: string, i: RequestInit) => (calls.push([u, i]), new Response(null, { status: 202 }))));
  const { initErrors, captureError } = await import("./errors.js");
  initErrors({ endpoint: "https://e.example/", publishableKey: "wtp_k", release: "r1", maxEvents: 3 });
  const err = (m: string, stack: string) => window.dispatchEvent(new ErrorEvent("error", { message: m, error: { name: "TypeError", message: m, stack } }));
  err("a", "TypeError: a\n    at f (https://x.test/a.js?v=1:3:4)\n    at https://x.test/b.js:5:6");
  err("a", "TypeError: a\n    at f (https://x.test/a.js?v=1:3:4)\n    at https://x.test/b.js:5:6"); // duplicate
  err("g", "g@https://x.test/c.js:7:8");
  window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: new Error("rej") }));
  captureError(new Error("over cap"));
  expect(calls).toHaveLength(3);
  const [url, init] = calls[0]!;
  expect(url).toBe("https://e.example/v1/rum/events?k=wtp_k");
  expect(init).toMatchObject({ method: "POST", keepalive: true, headers: { "content-type": "text/plain;charset=UTF-8" } });
  const b = JSON.parse(init.body as string);
  const a = b.events[0].attrs;
  expect(b.app.release).toBe("r1");
  expect(a).toMatchObject({ type: "TypeError", message: "a", handled: false, release: "r1" });
  expect(JSON.parse(a.frames)).toEqual([
    { function: "?", filename: "https://x.test/b.js", lineno: 5, colno: 6 },
    { function: "f", filename: "https://x.test/a.js", lineno: 3, colno: 4 },
  ]);
  expect(JSON.parse(calls[1]![1].body as string).events[0].attrs.frames).toContain("c.js");
  expect(b.user).toEqual({});
  expect(document.cookie).toBe("");
  expect(localStorage.length + sessionStorage.length).toBe(0);
  // handoff: listeners removed, captureError forwards
  const got: unknown[] = [];
  (globalThis as any)[Symbol.for("watchtower.errors")].handoff((e: unknown) => got.push(e));
  err("later", "x");
  captureError("boom");
  expect(calls).toHaveLength(3);
  expect(got).toEqual(["boom"]);
});

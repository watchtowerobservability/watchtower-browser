import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { expect, it, vi } from "vitest";
import { init } from "./beacon";

it("beacon_min_under_2kib_gz", async () => {
  const r = await build({ entryPoints: ["src/beacon.ts"], bundle: true, minify: true, format: "iife", target: "es2020", write: false });
  expect(gzipSync(r.outputFiles[0]!.contents, { level: 9 }).length).toBeLessThan(2048);
});

it("beacon_sends_once_on_hide_with_the_rum_batch_shape_and_caps_errors", async () => {
  const sent: Array<[string, Blob]> = [];
  vi.stubGlobal("navigator", { ...navigator, userAgent: "t", sendBeacon: (u: string, b: Blob) => (sent.push([u, b]), true) });
  init({ key: "wtp_k", endpoint: "https://e.example/", service: "web", release: "r1" });
  for (let i = 0; i < 15; i++) window.dispatchEvent(new ErrorEvent("error", { message: `boom${i}`, error: { stack: "Error: x\n    at f (a.js:1:2)" } }));
  window.dispatchEvent(new Event("pagehide"));
  window.dispatchEvent(new Event("pagehide"));
  expect(sent).toHaveLength(1);
  expect(sent[0]![0]).toBe("https://e.example/v1/rum/events?k=wtp_k");
  const b = JSON.parse(await sent[0]![1].text());
  expect(b.app).toEqual({ service: "web", release: "r1" });
  expect(b.session_id).toMatch(/^[0-9a-f-]{36}$/);
  const errors = b.events.filter((e: { type: string }) => e.type === "error");
  expect(errors).toHaveLength(10);
  expect(errors[0].attrs).toMatchObject({ message: "boom0", stack: "at f (a.js:1:2)", handled: false });
  expect(b.events.some((e: { name: string }) => e.name === "CLS")).toBe(true);
  vi.unstubAllGlobals();
});

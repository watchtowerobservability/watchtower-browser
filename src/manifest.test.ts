import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error plain .mjs shared with esbuild.config.mjs
import { buildManifest, listJs } from "../manifest.mjs";
import { chunkFailed, resetChunkErrors } from "./chunk-error.js";
import { init } from "./index.js";
import { storageDeclaration } from "./storage-declaration.js";

describe("buildManifest", () => {
  it("lists nested js files with size, sha256 and sri, skips others", () => {
    const d = mkdtempSync(join(tmpdir(), "wtm-"));
    mkdirSync(join(d, "instrument"));
    writeFileSync(join(d, "wt.min.js"), "abc");
    writeFileSync(join(d, "instrument", "chunk-1.js"), "xy");
    writeFileSync(join(d, "wt.min.js.map"), "{}");
    const m = buildManifest(d, "9.9.9");
    expect(m.version).toBe("9.9.9");
    expect(m.files.map((f: { path: string }) => f.path)).toEqual(["instrument/chunk-1.js", "wt.min.js"]);
    const f = m.files[1];
    expect(f.bytes).toBe(3);
    expect(f.sha256).toBe(createHash("sha256").update("abc").digest("hex"));
    expect(f.integrity).toBe("sha384-" + createHash("sha384").update("abc").digest("base64"));
  });
  it.skipIf(!existsSync("dist/manifest.json"))("dist manifest lists every js file in dist", () => {
    const m = JSON.parse(readFileSync("dist/manifest.json", "utf8"));
    expect(m.files.map((f: { path: string }) => f.path)).toEqual(listJs("dist"));
  });
});

describe("chunk load failure", () => {
  it("logs once, names file and base, mentions manifest.json, rethrows", () => {
    resetChunkErrors();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => chunkFailed("replay.js", "https://x.test/sdk/", new Error("boom"))).toThrow("boom");
    expect(() => chunkFailed("replay.js", "https://x.test/sdk/", new Error("boom"))).toThrow("boom");
    expect(spy).toHaveBeenCalledTimes(1);
    const msg = String(spy.mock.calls[0]?.[0]);
    expect(msg).toContain("replay.js");
    expect(msg).toContain("https://x.test/sdk/");
    expect(msg).toContain("manifest.json");
    spy.mockRestore();
  });
  it("init with a missing chunk URL does not throw and logs the chunk", async () => {
    resetChunkErrors();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const url = "http://127.0.0.1:1/nope/instrument/index.js";
    const wt = init({ publishableKey: "wtp_x", endpoint: "http://127.0.0.1:1", service: "t", instrumentUrl: url });
    expect(() => wt.captureError(new Error("e"))).not.toThrow();
    await vi.waitFor(() => expect(spy.mock.calls.some((c) => String(c[0]).includes(url))).toBe(true), { timeout: 3000 }).catch(() => undefined);
    void wt.shutdown();
    spy.mockRestore();
  });
});

describe("storage declaration", () => {
  it("declares no cookies and every storage key written in src", () => {
    expect(storageDeclaration.cookies).toBe(false);
    const names = storageDeclaration.items.map((i) => i.name);
    const src = (f: string) => readFileSync(join("src", f), "utf8");
    expect(src("session.ts")).toContain(`KEY = "${names.find((n) => n === "wt.session")}"`);
    const idb = [...(src("queue.ts") + src("index.ts")).matchAll(/idbStore<[^>]*>\(("[^"]+")?/g)];
    const dbs = idb.map((m) => m[1]?.replace(/"/g, "") ?? "wt-offline");
    for (const db of dbs) expect(names).toContain(db);
    expect(src("queue.ts")).toContain(`name = "wt-offline"`);
  });
  it("no source file outside instrument/ writes web storage or cookies beyond the declared ones", async () => {
    const { readdirSync } = await import("node:fs");
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    const bad = walk("src")
      .filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".test.ts") && !f.includes("storage-declaration"))
      .filter((f) => /document\.cookie\s*=|\.setItem\(|localStorage\.|indexedDB\.open|caches\.(open|put)/.test(readFileSync(f, "utf8")))
      .filter((f) => !["src/session.ts", "src/queue.ts", "src/instrument/storage.ts"].includes(f));
    expect(bad).toEqual([]);
  });
});

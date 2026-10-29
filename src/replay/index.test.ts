import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { effectiveLevel } from "./config";
import { chunkFetch, setup } from "./harness";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("config merge", () => {
  it("local_config_cannot_lower_remote_level", () => {
    expect(effectiveLevel("relaxed", "strict")).toBe("strict");
    expect(effectiveLevel("strict", "relaxed")).toBe("strict");
    expect(effectiveLevel("balanced", "relaxed")).toBe("balanced");
    expect(effectiveLevel(undefined, undefined)).toBe("strict");
  });

  it("enabled is local AND remote", () => {
    const t = setup({}, { remote: { enabled: false } });
    t.h.auto();
    expect(t.h.recording()).toBe(false);
    const t2 = setup({ enabled: false });
    t2.h.auto();
    expect(t2.h.recording()).toBe(false);
  });

  it("sends the effective level, not the local one", async () => {
    const t = setup({ maskLevel: "relaxed" }, { remote: { enabled: true, maskLevel: "balanced" } });
    t.h.start();
    t.h.stop();
    await t.h.flush();
    expect(t.posts[0]!.headers["X-WT-Mask"]).toBe("balanced");
  });
});

describe("lifecycle", () => {
  it("remote_disabled_stops_recorder", () => {
    const t = setup();
    t.h.start();
    expect(t.h.recording()).toBe(true);
    t.h.setRemote({ enabled: false });
    expect(t.h.recording()).toBe(false);
  });

  it("stops when the server answers 403", async () => {
    const t = setup({}, {}, chunkFetch(() => [403, "replay_disabled"]));
    t.h.start();
    await t.h.flush();
    await vi.waitFor(() => expect(t.h.recording()).toBe(false));
  });

  it("manual_start_stop", async () => {
    const onStart = vi.fn();
    const onStop = vi.fn();
    const t = setup({ sampleRate: 0, errorSampleRate: 0, onStart, onStop });
    t.h.auto();
    expect(t.h.recording()).toBe(false);
    t.h.start();
    expect(t.h.recording()).toBe(true);
    t.h.stop();
    await t.h.flush();
    expect(onStart).toHaveBeenCalledOnce();
    expect(onStop).toHaveBeenCalledOnce();
    expect(t.posts.length).toBeGreaterThan(0);
  });

  it("shouldRecord false prevents recording", () => {
    const t = setup({ shouldRecord: () => false });
    t.h.start();
    expect(t.h.recording()).toBe(false);
  });
});

describe("sampling and error buffer", () => {
  it("session_sample_zero_records_nothing_but_errors_buffer", async () => {
    document.body.innerHTML = "<p>before-error</p>";
    const t = setup({ sampleRate: 0, errorSampleRate: 1, maskLevel: "relaxed" }, { sampled: () => false });
    t.h.auto();
    expect(t.h.recording()).toBe(true);
    await t.h.flush();
    expect(t.posts).toHaveLength(0);
  });

  it("error_buffer_flushes_prior_60s_on_error", async () => {
    document.body.innerHTML = "<p>before-error</p>";
    const t = setup({ sampleRate: 0, errorBufferSeconds: 60, maskLevel: "relaxed" }, { sampled: () => false });
    t.h.auto();
    t.h.trigger();
    await t.h.flush();
    expect(t.posts.length).toBeGreaterThan(0);
    expect(t.all()).toContain("before-error");
    const first = JSON.parse(t.posts[0]!.text) as { type: number }[];
    expect(first.some((e) => e.type === 2)).toBe(true);
  });
});

describe("size", () => {
  it("replay_chunk_under_80kib_gz", async () => {
    const r = await build({
      entryPoints: ["src/replay/index.ts"],
      bundle: true,
      minify: true,
      format: "esm",
      target: "es2020",
      write: false,
    });
    expect(gzipSync(r.outputFiles[0]!.contents).length).toBeLessThan(80 * 1024);
  });
});

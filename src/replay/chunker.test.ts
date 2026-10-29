import { gzipSync, strToU8 } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { Chunker } from "./chunker";
import { chunkFetch } from "./harness";

const ev = (n: number, pad = 0) => ({ type: 3, timestamp: n, data: { source: 1, pad: "x".repeat(pad) } });
const mk = (f: ReturnType<typeof chunkFetch>, over: object = {}) =>
  new Chunker({ endpoint: "https://edge.test/", key: "wtp_k", session: () => "sess", level: "balanced", f: f.f, sleep: () => Promise.resolve(), ...over });

describe("chunker", () => {
  it("chunk_under_900kib_and_seq_monotonic", async () => {
    const f = chunkFetch();
    const c = mk(f);
    // incompressible-ish payload so the 900 KiB split path is exercised
    for (let i = 0; i < 40; i++) c.add({ type: 3, timestamp: i, data: { r: Array.from({ length: 30_000 }, () => Math.random().toString(36)).join("") } });
    await c.flush();
    expect(f.posts.length).toBeGreaterThan(1);
    expect(f.posts.map((p) => p.seq)).toEqual(f.posts.map((_, i) => i));
    for (const p of f.posts) {
      expect(gzipSync(strToU8(p.text)).length).toBeLessThan(900 * 1024);
      expect(p.headers["X-WT-Mask"]).toBe("balanced");
      expect(p.headers["Content-Encoding"]).toBe("gzip");
      expect(p.headers.Authorization).toBe("Bearer wtp_k");
      expect(p.url).toContain("/v1/replay/sess/chunks?seq=");
    }
  }, 30_000); // gzips ~10 MB of random text; slow on shared CI runners

  it("retry_same_seq_on_5xx", async () => {
    const f = chunkFetch((n) => (n <= 2 ? 503 : 200));
    const c = mk(f);
    c.add(ev(1));
    await c.flush();
    expect(f.posts.map((p) => p.seq)).toEqual([0, 0, 0]);
  });

  it("gives up after 5 retries and reports a drop", async () => {
    const f = chunkFetch(() => 500);
    const onDrop = vi.fn();
    const c = mk(f, { onDrop });
    c.add(ev(1));
    await c.flush();
    expect(f.posts).toHaveLength(6);
    expect(onDrop).toHaveBeenCalledOnce();
  });

  it("stops_on_replay_disabled_403", async () => {
    for (const [status, body, why] of [[403, "replay_disabled", "disabled"], [413, "", "session_cap"], [422, "mask_level_below_floor", "floor"]] as const) {
      const f = chunkFetch(() => [status, body]);
      const onStop = vi.fn();
      const c = mk(f, { onStop });
      c.add(ev(1));
      await c.flush();
      c.add(ev(2));
      await c.flush();
      expect(onStop).toHaveBeenCalledWith(why);
      expect(f.posts).toHaveLength(1);
    }
  });

  it("checkout flushes the previous chunk first", async () => {
    const f = chunkFetch();
    const c = mk(f);
    c.add(ev(1));
    c.add(ev(2), true);
    await c.flush();
    expect(f.posts.map((p) => JSON.parse(p.text).length)).toEqual([1, 1]);
  });
});

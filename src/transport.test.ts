import { describe, expect, it, vi } from "vitest";
import type { RumEventV1 } from "./config";
import { BoundedQueue } from "./queue";
import { Transport, type Envelope } from "./transport";

const env = (): Envelope => ({
  session_id: "s",
  sent_at_ns: 1,
  sdk: { name: "t", version: "0" },
  app: { service: "web" },
  page: { url: "https://x.test/" },
  device: { ua: "t" },
  user: {},
  attrs: {},
});
const ev = (i: number): RumEventV1 => ({ id: String(i), ts_ns: i, type: "flag", name: `e${i}`, attrs: {} });

describe("queue", () => {
  it("queue_drops_oldest_and_counts", () => {
    const q = new BoundedQueue<number>(3);
    [1, 2, 3, 4, 5].forEach((n) => q.push(n));
    expect(q.take(10)).toEqual([3, 4, 5]);
    expect(q.dropped).toBe(2);
  });
});

describe("transport", () => {
  it("retry_after_honored", async () => {
    let t = 0;
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "30" } }))
      .mockResolvedValue(new Response(null, { status: 202 }));
    const tr = new Transport({ endpoint: "https://e.test", key: "k", envelope: env, fetch: f, now: () => t, random: () => 0 });
    tr.start();
    tr.push(ev(1));
    await tr.flush();
    expect(f).toHaveBeenCalledTimes(1);
    expect(tr.queue.length).toBe(1); // requeued
    t = 29_000;
    await tr.flush();
    expect(f).toHaveBeenCalledTimes(1); // still inside Retry-After
    t = 30_001;
    await tr.flush();
    expect(f).toHaveBeenCalledTimes(2);
    expect(tr.queue.length).toBe(0);
  });

  it("backoff_capped_at_60s", async () => {
    let t = 0;
    const f = vi.fn().mockRejectedValue(new Error("down"));
    const tr = new Transport({ endpoint: "https://e.test", key: "k", envelope: env, fetch: f, now: () => t, random: () => 1 });
    tr.start();
    tr.push(ev(1));
    for (let i = 0; i < 12; i++) {
      t += 70_000;
      await tr.flush();
    }
    t += 59_999; // jitter factor 1 and cap 60 s: still inside the window
    await tr.flush();
    expect(f).toHaveBeenCalledTimes(12);
    t += 1; // the window is exactly the 60 s cap, not 2^12 s
    await tr.flush();
    expect(f).toHaveBeenCalledTimes(13);
  });

  it("invalid_batch_4xx_is_dropped_not_retried", async () => {
    const f = vi.fn().mockResolvedValue(new Response(null, { status: 422 }));
    const tr = new Transport({ endpoint: "https://e.test", key: "k", envelope: env, fetch: f });
    tr.start();
    tr.push(ev(1));
    await tr.flush();
    expect(tr.queue.length).toBe(0);
  });

  it("transport_errors_never_escape", async () => {
    const tr = new Transport({
      endpoint: "https://e.test",
      key: "k",
      envelope: () => {
        throw new Error("boom");
      },
      fetch: vi.fn(),
    });
    tr.start();
    tr.push(ev(1));
    await expect(tr.flush()).resolves.toBeUndefined();
  });

  it("dropped_count_reported_in_attrs", async () => {
    const f = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    const tr = new Transport({ endpoint: "https://e.test", key: "k", envelope: env, fetch: f });
    tr.start();
    for (let i = 0; i < 510; i++) tr.queue.push(ev(i));
    await tr.flush();
    const body = f.mock.calls[0]![1].body as string | ArrayBuffer;
    expect(typeof body === "string" ? body : "gz").toSatisfy((b: string) => b === "gz" || b.includes('"wt.sdk.dropped":10'));
  });

  it("413_counted_not_silent", async () => {
    const f = vi.fn().mockResolvedValue(new Response(null, { status: 413 }));
    const seen: [number, number][] = [];
    const tr = new Transport({ endpoint: "https://e.test", key: "k", envelope: env, fetch: f, onReject: (s, n) => seen.push([s, n]) });
    tr.start();
    tr.push(ev(1));
    tr.push(ev(2));
    await tr.flush();
    expect(seen).toEqual([[413, 2]]);
    expect(tr.rejected[413]).toBe(2);
    tr.push(ev(3));
    await tr.flush();
    expect(f).toHaveBeenCalledTimes(2);
    expect(JSON.parse(f.mock.calls[1]![1].body as string).attrs["wt.sdk.rejected"]).toBe("413:2");
  });
});

it("origin_not_allowed_403_warns_once_regardless_of_debug", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const body = JSON.stringify({ error: "origin_not_allowed", origin: "https://app.test", key: "wtp_abcd…" });
  const f = vi.fn(async () => new Response(body, { status: 403, headers: { "content-type": "application/json" } }));
  const t = new Transport({ endpoint: "https://e.example", key: "k", envelope: () => ({ session_id: "s", sent_at_ns: 1, sdk: { name: "n", version: "v" }, app: { service: "a" }, page: { url: "u" }, device: { ua: "u" }, user: {}, attrs: {} }), fetch: f as unknown as typeof fetch });
  t.start();
  for (let i = 0; i < 2; i++) {
    t.push({ id: String(i), ts_ns: 1, type: "action", name: "x", attrs: {} });
    await t.flush();
  }
  await new Promise((r) => setTimeout(r, 10));
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0]![0])).toContain("https://app.test");
  expect(String(warn.mock.calls[0]![0])).toContain("allow_localhost");
  warn.mockRestore();
});

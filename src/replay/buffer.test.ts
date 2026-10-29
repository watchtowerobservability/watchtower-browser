import { describe, expect, it } from "vitest";
import { RingBuffer } from "./buffer";

const ev = (ts: number) => ({ type: 3, timestamp: ts, data: {} });

describe("ring buffer", () => {
  it("keeps roughly the last window, always starting at a checkout", () => {
    const b = new RingBuffer(60_000);
    b.push(ev(0), true);
    for (let t = 1; t < 200; t++) {
      if (t % 30 === 0) b.push(ev(t * 1000), true);
      else b.push(ev(t * 1000), false);
    }
    const out = b.drain();
    expect(out[0]!.timestamp).toBeGreaterThanOrEqual(120_000);
    expect(out[out.length - 1]!.timestamp).toBe(199_000);
    expect(b.drain()).toEqual([]);
  });

  it("drops oldest segments past the byte cap but keeps the newest", () => {
    const b = new RingBuffer(3_600_000, 1000);
    for (let i = 0; i < 10; i++) b.push({ type: 2, timestamp: i, data: { p: "x".repeat(400) } }, true);
    expect(b.size()).toBeLessThanOrEqual(1000 + 500);
    expect(b.drain().at(-1)!.timestamp).toBe(9);
  });
});

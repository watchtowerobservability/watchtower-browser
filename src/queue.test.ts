import { describe, expect, it, vi } from "vitest";
import type { RumEventV1 } from "./config";
import { MemoryStore } from "./queue";
import { Transport, type Envelope } from "./transport";

const env = (): Envelope => ({
  session_id: "s", sent_at_ns: 1, sdk: { name: "t", version: "0" }, app: { service: "web" },
  page: { url: "https://x.test/" }, device: { ua: "t" }, user: {}, attrs: {},
});
const ev = (i: number): RumEventV1 => ({ id: String(i), ts_ns: i, type: "flag", name: `e${i}`, attrs: {} });

describe("offline queue", () => {
  it("offline_persist_and_flush", async () => {
    const store = new MemoryStore<RumEventV1>();
    let t = 0;
    const f = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValue(new Response(null, { status: 202 }));
    const tr = new Transport({ endpoint: "https://e.test", key: "k", envelope: env, fetch: f, now: () => t, random: () => 0, offline: store });
    tr.start();
    tr.push(ev(1));
    tr.push(ev(2));
    await tr.flush();
    expect(store.items.map((e) => e.id)).toEqual(["1", "2"]); // persisted, not lost
    expect(tr.queue.length).toBe(0);
    t = 120_000;
    tr.start(); // a later page load drains the store back into the queue
    await new Promise((r) => setTimeout(r, 0));
    expect(tr.queue.length).toBe(2);
    await tr.flush();
    const sent = JSON.parse(f.mock.calls[1]![1].body as string).events.map((e: RumEventV1) => e.id);
    expect(sent).toEqual(["1", "2"]);
    expect(store.items).toHaveLength(0);
  });
});

import { afterEach, expect, it, vi } from "vitest";
import { LogShipper } from "./logs";
import { MemoryStore } from "./queue";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const FLUSH_WAIT = 5000; // flush interval; longer than the first backoff, so it decides the first retry
const records = (i: RequestInit) => JSON.parse(i.body as string).resourceLogs[0].scopeLogs[0].logRecords as { body: { stringValue: string } }[];

it("ships_otlp_log_records", async () => {
  const f = vi.fn(async (_u: string, _i: RequestInit) => new Response("{}"));
  vi.stubGlobal("fetch", f);
  const s = new LogShipper("https://otlp.test/", "wtp_k", { "service.name": "web" });
  s.push("warn", "disk", { "session.id": "s1", synthetic: true }, { trace_id: "a".repeat(32), span_id: "b".repeat(16) });
  await s.flush();
  const [url, init] = f.mock.calls[0]!;
  expect(url).toBe("https://otlp.test/v1/logs");
  expect((init.headers as Record<string, string>).authorization).toBe("Bearer wtp_k");
  const rl = JSON.parse(init.body as string).resourceLogs[0];
  expect(rl.resource.attributes[0]).toEqual({ key: "service.name", value: { stringValue: "web" } });
  const r = rl.scopeLogs[0].logRecords[0];
  expect(r).toMatchObject({ severityNumber: 13, severityText: "WARN", body: { stringValue: "disk" }, traceId: "a".repeat(32) });
  expect(r.timeUnixNano).toMatch(/^\d{19}$/);
  expect(r.attributes).toContainEqual({ key: "synthetic", value: { boolValue: true } });
  await s.flush();
  expect(f).toHaveBeenCalledOnce(); // nothing left to send
});

it("warns_once_when_undeliverable", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const s = new LogShipper("https://edge.test", "k", {});
  for (let i = 0; i < 2; i++) {
    s.push("info", "x", {});
    await s.flush();
  }
  expect(warn).toHaveBeenCalledOnce();
  const none = new LogShipper("not a url", "k", {});
  none.push("info", "x", {});
  await none.flush();
  expect(warn).toHaveBeenCalledTimes(2);
  warn.mockRestore();
});

it("retries_a_503_with_backoff_and_delivers_the_batch_once", async () => {
  vi.useFakeTimers();
  const f = vi.fn(async (_u: string, _i: RequestInit) => new Response("{}"));
  f.mockImplementationOnce(async () => new Response("", { status: 503 }));
  vi.stubGlobal("fetch", f);
  const s = new LogShipper("https://otlp.test", "k", {}, undefined, () => 1);
  s.push("error", "kept", {});
  await s.flush();
  expect(f).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(FLUSH_WAIT - 1);
  expect(f).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(f).toHaveBeenCalledTimes(2);
  expect(records(f.mock.calls[1]![1]).map((r) => r.body.stringValue)).toEqual(["kept"]);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(f).toHaveBeenCalledTimes(2); // delivered: nothing is sent again
});

it("honours_retry_after", async () => {
  vi.useFakeTimers();
  const f = vi.fn(async (_u: string, _i: RequestInit) => new Response("{}"));
  f.mockImplementationOnce(async () => new Response("", { status: 429, headers: { "Retry-After": "20" } }));
  vi.stubGlobal("fetch", f);
  const s = new LogShipper("https://otlp.test", "k", {});
  s.push("info", "x", {});
  await s.flush();
  await vi.advanceTimersByTimeAsync(19_999);
  expect(f).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(f).toHaveBeenCalledTimes(2);
});

it("does_not_retry_a_refused_batch", async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const f = vi.fn(async () => new Response("", { status: 400 }));
  vi.stubGlobal("fetch", f);
  const s = new LogShipper("https://otlp.test", "k", {});
  s.push("info", "x", {});
  await s.flush();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(f).toHaveBeenCalledOnce();
  expect(warn).toHaveBeenCalledOnce();
  warn.mockRestore();
});

it("parks_a_batch_offline_and_sends_it_after_the_next_success", async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const f = vi.fn(async (_u: string, _i: RequestInit) => new Response("{}"));
  f.mockImplementationOnce(async () => { throw new TypeError("offline"); });
  vi.stubGlobal("fetch", f);
  const store = new MemoryStore<unknown>();
  const s = new LogShipper("https://otlp.test", "k", {}, store, () => 1);
  s.push("info", "first", {});
  await s.flush();
  s.push("info", "second", {});
  await s.flush();
  await vi.advanceTimersByTimeAsync(FLUSH_WAIT);
  const sent = f.mock.calls.slice(1).flatMap(([, i]) => records(i).map((r) => r.body.stringValue));
  expect(sent.sort()).toEqual(["first", "second"]);
  expect(await store.drain()).toEqual([]);
  warn.mockRestore();
});

it("retries_a_parked_batch_with_no_new_records", async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const f = vi.fn(async (_u: string, _i: RequestInit) => new Response("{}"));
  f.mockImplementationOnce(async () => { throw new TypeError("offline"); });
  vi.stubGlobal("fetch", f);
  const store = new MemoryStore<unknown>();
  const s = new LogShipper("https://otlp.test", "k", {}, store, () => 1);
  s.push("info", "only", {});
  await s.flush();
  await vi.advanceTimersByTimeAsync(FLUSH_WAIT);
  expect(f).toHaveBeenCalledTimes(2);
  expect(records(f.mock.calls[1]![1]).map((r) => r.body.stringValue)).toEqual(["only"]);
  warn.mockRestore();
});

it("discard_also_clears_the_offline_store", async () => {
  const store = new MemoryStore<unknown>();
  await store.save([{ body: { stringValue: "old" } }]);
  new LogShipper("https://otlp.test", "k", {}, store).discard();
  await Promise.resolve();
  expect(await store.drain()).toEqual([]);
});

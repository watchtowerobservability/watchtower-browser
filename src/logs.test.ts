import { afterEach, expect, it, vi } from "vitest";
import { LogShipper } from "./logs";

afterEach(() => vi.unstubAllGlobals());

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

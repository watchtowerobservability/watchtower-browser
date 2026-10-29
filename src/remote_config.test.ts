import { describe, expect, it, vi } from "vitest";
import { fetchRemoteConfig } from "./remote_config";

describe("remote config", () => {
  it("remote_config_failure_defaults_replay_off", async () => {
    const c = await fetchRemoteConfig("https://e.test", "k", vi.fn().mockRejectedValue(new Error("net")));
    expect(c.replay.enabled).toBe(false);
    expect(c.rum_enabled).toBe(true);
  });

  it("non_ok_status_uses_defaults", async () => {
    const c = await fetchRemoteConfig("https://e.test", "k", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
    expect(c.replay.enabled).toBe(false);
  });

  it("times_out_after_2s_with_defaults", async () => {
    vi.useFakeTimers();
    try {
      const hang = vi.fn((_u: string, i: RequestInit) => new Promise((_, rej) => i.signal!.addEventListener("abort", () => rej(new Error("abort")))));
      const p = fetchRemoteConfig("https://e.test", "k", hang as never);
      await vi.advanceTimersByTimeAsync(2001);
      expect((await p).replay.enabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("server_values_are_used", async () => {
    const body = { rum_enabled: true, sample_rate: 0.25, replay: { enabled: true } };
    const c = await fetchRemoteConfig("https://e.test", "k", vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
    expect(c.sample_rate).toBe(0.25);
    expect(c.replay.enabled).toBe(true);
  });
});

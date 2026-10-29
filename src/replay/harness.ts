import { gunzipSync } from "node:zlib";
import { vi } from "vitest";
import type { MaskLevel, ReplayConfig } from "./config";
import { startReplay, type ReplayDeps } from "./index";

export interface Posted {
  url: string;
  seq: number;
  headers: Record<string, string>;
  text: string;
}

/** Fetch stub for chunk uploads; `status(n)` picks the answer for the n-th call (default 200). */
export function chunkFetch(status: (n: number) => number | [number, string] = () => 200) {
  const posts: Posted[] = [];
  const f = vi.fn(async (url: string, init: RequestInit = {}) => {
    posts.push({
      url,
      seq: Number(new URL(url).searchParams.get("seq")),
      headers: init.headers as Record<string, string>,
      text: gunzipSync(Buffer.from(init.body as Uint8Array)).toString(),
    });
    const s = status(posts.length);
    return Array.isArray(s) ? new Response(s[1], { status: s[0] }) : new Response("", { status: s });
  });
  return { f: f as unknown as typeof fetch, posts, all: () => posts.map((p) => p.text).join("\n") };
}

export function setup(cfg: ReplayConfig = {}, over: Partial<ReplayDeps> = {}, f = chunkFetch()) {
  const h = startReplay({
    cfg: { enabled: true, sampleRate: 1, maskLevel: "strict", ...cfg },
    remote: { enabled: true },
    endpoint: "https://edge.test",
    key: "wtp_test",
    sessionId: () => "11111111-1111-4111-8111-111111111111",
    sampled: (r) => r > 0,
    errorSampled: (r) => r > 0,
    f: f.f,
    sleep: () => Promise.resolve(),
    ...over,
  });
  return { h, ...f };
}

export const level = (l: MaskLevel): ReplayConfig => ({ maskLevel: l });

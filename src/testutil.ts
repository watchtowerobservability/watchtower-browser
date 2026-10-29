import { gunzipSync } from "node:zlib";
import { vi } from "vitest";

export interface Call {
  url: string;
  init: RequestInit;
}

export function bodyOf(init: RequestInit): any {
  const b = init.body as string | ArrayBuffer | Uint8Array;
  return JSON.parse(typeof b === "string" ? b : gunzipSync(Buffer.from(b as ArrayBuffer)).toString());
}

/** Stub global fetch: config endpoint answers `config`, the events endpoint answers `events(n)`. */
export function stubFetch(
  config: unknown = { rum_enabled: true, id_salt: "salt", replay: { enabled: false } },
  events: (n: number) => Response = () => new Response(null, { status: 202 }),
) {
  const calls: Call[] = [];
  const f = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if (url.endsWith("/v1/rum/config")) return new Response(JSON.stringify(config), { status: 200 });
    return events(calls.filter((c) => c.url.includes("/v1/rum/events")).length);
  });
  vi.stubGlobal("fetch", f);
  return { calls, events: () => calls.filter((c) => c.url.includes("/v1/rum/events")) };
}

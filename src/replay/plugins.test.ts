import { afterEach, describe, expect, it, vi } from "vitest";
import { maskBody, networkPlugin, scrubUrl, statePlugin } from "./plugins";

afterEach(() => vi.unstubAllGlobals());

describe("plugins", () => {
  it("network_plugin_drops_authorization_header", async () => {
    vi.stubGlobal("fetch", async () => new Response("secret-body", { status: 201, headers: { "set-cookie": "a=b", "x-req": "1", authorization: "Bearer z" } }));
    const out: any[] = [];
    const stop = networkPlugin({ urls: ["/api/"], captureHeaders: ["set-cookie", "authorization", "x-req"] }).start((p) => out.push(p));
    await fetch("https://app.test/api/x?token=abc#frag", { method: "post", headers: { Authorization: "Bearer q" }, body: "req-body" });
    await fetch("https://other.test/y");
    stop();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ method: "POST", url: "https://app.test/api/x?token=*", status: 201, headers: { "x-req": "1" } });
    expect(JSON.stringify(out)).not.toMatch(/abc|secret-body|req-body|Bearer|a=b/);
  });

  it("bodies_masked_except_allow_listed_keys", async () => {
    vi.stubGlobal("fetch", async () => new Response('{"id":7,"email":"a@b.test"}', { status: 200 }));
    const out: any[] = [];
    const stop = networkPlugin({ urls: ["/api/"], bodies: { allowKeys: ["id"] }, captureRequestHeaders: ["x-req", "authorization"] }).start((p) => out.push(p));
    await fetch("https://app.test/api/u", { method: "POST", headers: { "x-req": "1", authorization: "Bearer z" }, body: '{"card":"4242","id":3}' });
    stop();
    expect(out[0].request_body).toEqual({ card: "*", id: 3 });
    expect(out[0].response_body).toEqual({ id: 7, email: "*" });
    expect(out[0].request_headers).toEqual({ "x-req": "1" });
    expect(maskBody("not json")).toEqual({ masked_bytes: 8 });
  });

  it("no_bodies_by_default", async () => {
    vi.stubGlobal("fetch", async () => new Response('{"a":"secret"}'));
    const out: any[] = [];
    const stop = networkPlugin({ urls: ["/api/"] }).start((p) => out.push(p));
    await fetch("https://app.test/api/u", { method: "POST", body: '{"b":"secret2"}' });
    stop();
    expect(JSON.stringify(out)).not.toMatch(/secret/);
  });

  it("scrubs query values", () => {
    expect(scrubUrl("https://a.test/p?a=1&b=2")).toBe("https://a.test/p?a=*&b=*");
  });

  it("state_plugin_capped_32kib", () => {
    vi.useFakeTimers();
    const out: any[] = [];
    const stop = statePlugin({ name: "redux", getState: () => ({ big: "x".repeat(40_000) }) }).start((p) => out.push(p));
    stop();
    vi.useRealTimers();
    expect(out[0]).toMatchObject({ truncated: true });
    const small: any[] = [];
    statePlugin({ name: "s", getState: () => ({ n: 1 }), serialize: (s) => ({ ...s, ok: true }) }).start((p) => small.push(p))();
    expect(small[0]).toEqual({ state: { n: 1, ok: true } });
  });
});

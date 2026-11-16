import { afterEach, describe, expect, it, vi } from "vitest";
import { warnOnRefusal } from "./export-warn";

type Res = { error?: unknown };
const fake = (code: number) => ({ export: (_s: never, cb: (r: Res) => void) => cb({ error: { code } }) });

describe("warnOnRefusal", () => {
  afterEach(() => vi.restoreAllMocks());

  it("warns_once_naming_url_and_status_on_404", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const cb = vi.fn();
    const e = warnOnRefusal(fake(404), "https://x.test/v1/traces");
    e.export([] as never, cb);
    e.export([] as never, cb);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("HTTP 404 from https://x.test/v1/traces");
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("stays_quiet_on_503", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    warnOnRefusal(fake(503), "u").export([] as never, () => undefined);
    expect(warn).not.toHaveBeenCalled();
  });
});

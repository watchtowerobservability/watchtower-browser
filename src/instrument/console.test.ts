import { afterEach, expect, it, vi } from "vitest";
import { installConsole } from "./console";
import { mkCtx } from "./testutil";

let un: (() => void) | undefined;
afterEach(() => un?.());

it("console_levels_become_log_records", () => {
  const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const { c, logs } = mkCtx({ captureConsole: ["warn"] });
  un = installConsole(c);
  console.warn("disk", { pct: 91 });
  expect(logs).toEqual([["warn", 'disk {"pct":91}']]);
  expect(spy).toHaveBeenCalledOnce(); // the host still logs
  un!();
  un = undefined;
  console.warn("after");
  expect(logs).toHaveLength(1);
  spy.mockRestore();
});

it("console_capture_off_by_default", () => {
  const { c } = mkCtx();
  expect(installConsole(c)).toBeUndefined();
});

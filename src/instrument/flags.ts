import type { Attrs, FlagAdapter } from "../config";

const MAX_KEYS = 50;
const MAX_VALUE = 128;

/** Records a flag evaluation: a `flag` event plus the session attribute `flag.<key>` (<= 50 keys). */
export function makeFlagRecorder(
  emit: (key: string, attrs: Attrs) => void,
  setAttr: (k: string, v: string) => void,
): (key: string, value: unknown) => void {
  const keys = new Set<string>();
  return (key, value) => {
    if (!keys.has(key)) {
      if (keys.size >= MAX_KEYS) return;
      keys.add(key);
    }
    const v = String(value).slice(0, MAX_VALUE);
    setAttr(`flag.${key}`, v);
    emit(key, { value: v });
  };
}

// Adapters only listen to evaluation callbacks; no flag SDK is bundled.

export function launchDarklyAdapter(ld: {
  on(ev: "change", cb: (c: Record<string, { current: unknown }>) => void): void;
}): FlagAdapter {
  return {
    name: "launchdarkly",
    attach: (record) => ld.on("change", (c) => Object.keys(c).forEach((k) => record(k, c[k]!.current))),
  };
}

/** Pass as `flags: [hook]` and register with `OpenFeature.addHooks(hook)`. */
export function openFeatureHook(): FlagAdapter & {
  after(ctx: unknown, details: { flagKey: string; value: unknown }): void;
} {
  let rec: ((k: string, v: unknown) => void) | undefined;
  return {
    name: "openfeature",
    attach: (r) => void (rec = r),
    after: (_ctx, d) => rec?.(d.flagKey, d.value),
  };
}

export function growthBookAdapter(gb: {
  setTrackingCallback(cb: (exp: { key: string }, res: { key: string }) => void): void;
}): FlagAdapter {
  return { name: "growthbook", attach: (record) => gb.setTrackingCallback((exp, res) => record(exp.key, res.key)) };
}

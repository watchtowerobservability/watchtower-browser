import type { Attrs } from "./config";

interface LucidaLike {
  getSessionId?: () => string;
  getDistinctId?: () => string;
}

/** Lucida's session and distinct ids: the `init({ lucida })` client, else the SDK's `globalThis.lucida`. Never throws. */
export function lucidaAttrs(client?: LucidaLike): Attrs {
  const out: Attrs = {};
  try {
    const g = (globalThis as { lucida?: LucidaLike }).lucida;
    const s = (client?.getSessionId?.() || undefined) ?? g?.getSessionId?.();
    const d = (client?.getDistinctId?.() || undefined) ?? g?.getDistinctId?.();
    if (s) out["lucida.session_id"] = String(s).slice(0, 128);
    if (d) out["lucida.distinct_id"] = String(d).slice(0, 128);
  } catch {
    /* host analytics must not break us */
  }
  return out;
}

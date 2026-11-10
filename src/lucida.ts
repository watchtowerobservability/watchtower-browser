import type { Attrs } from "./config";

interface LucidaLike {
  getSessionId?: () => string;
}

/** Lucida's session id: the `init({ lucida })` client, else the SDK's `globalThis.lucida`. Never throws. */
export function lucidaAttrs(client?: LucidaLike): Attrs {
  try {
    const s = (client?.getSessionId?.() || undefined) ?? (globalThis as { lucida?: LucidaLike }).lucida?.getSessionId?.();
    return s ? { "lucida.session_id": String(s).slice(0, 128) } : {};
  } catch {
    return {};
  }
}

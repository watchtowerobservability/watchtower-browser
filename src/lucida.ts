import type { Attrs } from "./config";

interface LucidaLike {
  getSessionId?: () => string;
}

/** Lucida's session id when its SDK is on the page, so Watchtower can link the same session. Never throws. */
export function lucidaAttrs(): Attrs {
  try {
    const s = (globalThis as { lucida?: LucidaLike }).lucida?.getSessionId?.();
    return s ? { "lucida.session_id": String(s).slice(0, 128) } : {};
  } catch {
    return {};
  }
}

import type { Attrs } from "./config";

interface PostHogLike {
  get_distinct_id?: () => string;
  get_session_id?: () => string;
  register?: (props: Record<string, string>) => void;
}

function ph(): PostHogLike | undefined {
  return (globalThis as { posthog?: PostHogLike }).posthog;
}

/** Read lazily per batch; attrs only when PostHog is present. Never throws. */
export function posthogAttrs(): Attrs {
  const out: Attrs = {};
  try {
    const d = ph()?.get_distinct_id?.();
    const s = ph()?.get_session_id?.();
    if (d) out["posthog.distinct_id"] = d;
    if (s) out["posthog.session_id"] = s;
  } catch {
    /* host analytics must not break us */
  }
  return out;
}

export function registerSession(sessionId: string): void {
  try {
    ph()?.register?.({ watchtower_session_id: sessionId });
  } catch {
    /* ignore */
  }
}

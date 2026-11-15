// Tiny RUM beacon: LCP, CLS, INP (approximated) and up to 10 uncaught errors, sent once when the page is hidden.
// Same endpoint and payload as the full SDK's unload path (POST <endpoint>/v1/rum/events, publishable key in `?k=`).
// No tracing, replay, console capture or storage. INP here = the longest event duration among interactions
// (web-vitals reports a high percentile of them), so it can read higher than the full SDK on busy pages.
export interface BeaconOptions {
  key: string;
  endpoint?: string;
  service?: string;
  release?: string;
  /** `granted` (default, like the full client) sends on hide; `pending` and `denied` send nothing until `grantConsent()`. Metrics are kept in memory only. */
  consent?: "granted" | "pending" | "denied";
}

export interface BeaconHandle {
  grantConsent(): void;
  revokeConsent(): void;
}

const uuid = (): string => (([1e7] as unknown as string) + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (c) => ((+c ^ (Math.random() * 16) >> (+c / 4)) as number).toString(16));
const LIM: Record<string, number[]> = { LCP: [2500, 4000], CLS: [0.1, 0.25], INP: [200, 500] };

export function init(o: BeaconOptions): BeaconHandle {
  let consent = o.consent ?? "granted";
  const w = window;
  const sid = uuid();
  const v: Record<string, number> = { CLS: 0, INP: 0 };
  const errs: Array<[string, string, string]> = [];
  let sent = false;
  const watch = (type: string, f: (e: any) => void, extra?: object): void => {
    try {
      const po = new PerformanceObserver((l) => l.getEntries().forEach(f));
      po.observe({ type, buffered: true, ...extra });
    } catch {
      /* entry type unsupported */
    }
  };
  watch("largest-contentful-paint", (e) => (v.LCP = e.startTime));
  watch("layout-shift", (e) => e.hadRecentInput || (v.CLS! += e.value));
  watch("event", (e) => e.interactionId && (v.INP = Math.max(v.INP!, e.duration)), { durationThreshold: 40 });
  const err = (type: string, msg: unknown, st?: string): void => {
    if (errs.length < 10) errs.push([type, String(msg).slice(0, 1024), (st || "").split("\n").find((l) => /:\d+/.test(l))?.trim().slice(0, 300) || ""]);
  };
  w.addEventListener("error", (e) => err("Error", e.message, e.error?.stack));
  w.addEventListener("unhandledrejection", (e) => err("UnhandledRejection", e.reason?.message ?? e.reason, e.reason?.stack));

  const send = (): void => {
    if (sent || consent !== "granted") return;
    sent = true;
    const ts_ns = Date.now() * 1e6;
    const page = location.href.split(/[?#]/)[0]!;
    const events = Object.keys(v)
      .filter((n) => v[n] !== undefined && (n !== "INP" || v.INP))
      .map((n) => ({ id: uuid(), ts_ns, type: "vital", name: n, value: v[n], attrs: { rating: v[n]! <= LIM[n]![0]! ? "good" : v[n]! <= LIM[n]![1]! ? "needs-improvement" : "poor", url: page } }))
      .concat(errs.map(([name, message, stack]) => ({ id: uuid(), ts_ns, type: "error", name, value: undefined as never, attrs: { type: name, message, stack, handled: false, mechanism: "onerror", frames: "[]", debug_ids: "{}" } as never })));
    const body = JSON.stringify({
      session_id: sid,
      sent_at_ns: ts_ns,
      sdk: { name: "@watchtowerobservability/browser/beacon", version: "beacon" },
      app: { service: o.service || "web", release: o.release },
      page: { url: page, referrer: document.referrer ? document.referrer.split(/[?#]/)[0] : undefined },
      device: { ua: navigator.userAgent, viewport: [w.innerWidth, w.innerHeight], dpr: w.devicePixelRatio },
      user: {},
      attrs: {},
      events,
    });
    const url = `${(o.endpoint || "https://edge.watchtowerops.net").replace(/\/$/, "")}/v1/rum/events`;
    let ok = false;
    try {
      ok = navigator.sendBeacon(`${url}?k=${encodeURIComponent(o.key)}`, new Blob([body], { type: "text/plain" }));
    } catch {
      /* fall through */
    }
    ok || fetch(url, { method: "POST", body, keepalive: true, headers: { Authorization: `Bearer ${o.key}`, "Content-Type": "application/json" } }).catch(() => 0);
  };
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && send());
  w.addEventListener("pagehide", send);
  return { grantConsent: () => void (consent = "granted"), revokeConsent: () => void (consent = "denied") };
}

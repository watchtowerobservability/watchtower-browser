import {
  DEFAULT_REMOTE,
  SDK,
  defaultRelease,
  type Attrs,
  type RemoteConfig,
  type RumEventV1,
  type WatchtowerConfig,
} from "./config";
import { hashUserId, rand, uuid } from "./ids";
import { lucidaAttrs } from "./lucida";
import { scrubUrl, setUrlScrubbing } from "./scrub";
import { posthogAttrs, registerSession } from "./posthog";
import type { Uninstall } from "./instrument/ctx";
import { makeFlagRecorder } from "./instrument/flags";
import { makeJourney, type Journey } from "./instrument/journeys";
import { fetchRemoteConfig } from "./remote_config";
import type { ReplayHandle } from "./replay";
import type { MaskLevel } from "./replay/config";
import { LogShipper, type LogLevel } from "./logs";
import { idbStore } from "./queue";
import { Session } from "./session";
import { Transport, type Envelope } from "./transport";

export type { RumEventV1, WatchtowerConfig, ReplayConfig, FlagAdapter, StorageConfig } from "./config";

export type { Journey };
export type { Feedback, FeedbackWidgetOptions } from "./feedback";
export { growthBookAdapter, launchDarklyAdapter, openFeatureHook } from "./instrument/flags";

export interface WatchtowerClient {
  captureError(err: unknown, ctx?: Attrs): void;
  setUser(u: { id?: string }): void;
  setAttribute(k: string, v: string | number | boolean): void;
  journey(name: string): Journey;
  flag(key: string, value: unknown): void;
  /** A log record (level default info) with the session id. */
  log(message: string, o?: { level?: "debug" | "info" | "warn" | "error"; attrs?: Attrs }): void;
  /** Report a view by name, for apps whose routes do not map to URLs. */
  setView(name: string): void;
  /** Stop sending events and logs until `unpause`; the instruments stay installed. */
  pause(): void;
  unpause(): void;
  /** A numeric measurement, sent as vital `custom.<name>`. */
  measure(name: string, value: number, attrs?: Attrs): void;
  /** A named custom event. */
  event(name: string, attrs?: Attrs): void;
  /** Dynamic probe point: `vars` runs only while an active probe targets `name` (needs `probes.key`). */
  probe(name: string, vars: () => Record<string, unknown>): void;
  stop(): void;
  replay: { start(): void; stop(): void; flush(): Promise<void> };
  sessionId(): string;
  /** Send user feedback, linked to the last captured error, the session and its replay (ERR-014). */
  feedback(f: import("./feedback").Feedback): Promise<boolean>;
  /** Add the opt-in feedback button and dialog; with `openOnError` it also asks after an error. */
  feedbackWidget(o?: import("./feedback").FeedbackWidgetOptions): void;
  shutdown(): Promise<void>;
  /** Start the SDK after `init({ consent: "pending" })`; a no-op while already running. */
  grantConsent(): void;
  /** Stop, drop queued events and logs, and clear `wt.session`; `grantConsent()` starts afresh. */
  revokeConsent(): void;
}

declare const __WT_IIFE__: boolean;
/** A lazy chunk. An explicit URL (or the script-tag IIFE build, which has no bundler) loads by URL,
 * with `webpackIgnore`/`@vite-ignore` so bundlers leave the expression alone; otherwise the static
 * `stat()` import lets webpack, Next and Vite split and resolve the chunk themselves. */
function chunk<T>(url: string | undefined, rel: string, stat: () => Promise<T>): Promise<T> {
  if (url) return (__WT_IIFE__ ? import(/* @vite-ignore */ url) : import("./load-url.js").then((m) => m.loadUrl(url))) as Promise<T>;
  if (__WT_IIFE__) return import(/* webpackIgnore: true */ /* @vite-ignore */ new URL(rel, import.meta.url).href) as Promise<T>;
  return stat();
}

const noop = (): void => undefined;
const NOOP_CLIENT: WatchtowerClient = {
  captureError: noop,
  setUser: noop,
  setAttribute: noop,
  journey: () => ({ step: noop, fail: noop }),
  flag: noop,
  log: noop,
  setView: noop,
  pause: noop,
  unpause: noop,
  measure: noop,
  event: noop,
  probe: noop,
  stop: noop,
  replay: { start: noop, stop: noop, flush: () => Promise.resolve() },
  sessionId: () => "",
  feedback: () => Promise.resolve(false),
  feedbackWidget: noop,
  shutdown: () => Promise.resolve(),
  grantConsent: noop,
  revokeConsent: noop,
};

/** Every public method swallows its own errors: the SDK never throws into the host app. */
function safe<A extends unknown[], R>(fn: (...a: A) => R, dflt: R, debug?: boolean): (...a: A) => R {
  return (...a) => {
    try {
      return fn(...a);
    } catch (e) {
      if (debug) console.warn("[watchtower]", e);
      return dflt;
    }
  };
}

export function init(cfg: WatchtowerConfig): WatchtowerClient {
  try {
    return gated(cfg.release ? cfg : { ...cfg, release: defaultRelease() });
  } catch (e) {
    if (cfg?.debug) console.warn("[watchtower] init failed", e);
    return NOOP_CLIENT;
  }
}

type Built = { client: WatchtowerClient; revoke: () => void };

/** Consent gate: calls go to the running client, or to the no-op one until consent is granted
 * (calls made before the grant are dropped, not queued). */
function gated(cfg: WatchtowerConfig): WatchtowerClient {
  let cur: Built | undefined = cfg.consent === "pending" ? undefined : build(cfg);
  const c = (): WatchtowerClient => cur?.client ?? NOOP_CLIENT;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(NOOP_CLIENT) as Array<keyof WatchtowerClient>) {
    out[k] = (...a: unknown[]) => (c()[k] as (...x: unknown[]) => unknown)(...a);
  }
  out.replay = { start: () => c().replay.start(), stop: () => c().replay.stop(), flush: () => c().replay.flush() };
  out.grantConsent = safe(() => void (cur ??= build(cfg)), undefined, cfg.debug);
  out.revokeConsent = safe(() => {
    cur?.revoke();
    cur = undefined;
    new Session().clear();
  }, undefined, cfg.debug);
  return out as unknown as WatchtowerClient;
}

/** Our browser-check runner sets `__WT_SYNTHETIC__`; k6 browser sets `k6`. Such sessions are tagged
 * `synthetic` so RUM views can leave them out. */
export function syntheticAttrs(w: Record<string, unknown> = window as unknown as Record<string, unknown>): Attrs {
  const m = w.__WT_SYNTHETIC__ as { check_id?: unknown; run_id?: unknown } | undefined;
  if (m && typeof m === "object") {
    const a: Attrs = { synthetic: true, "synthetic.source": "watchtower" };
    if (typeof m.check_id === "string") a["synthetic.check_id"] = m.check_id.slice(0, 64);
    if (typeof m.run_id === "string") a["synthetic.run_id"] = m.run_id.slice(0, 64);
    return a;
  }
  return "k6" in w ? { synthetic: true, "synthetic.source": "k6" } : {};
}

/** Resolves when a prerendered page is shown (at once when it was not prerendered). */
function activated(): Promise<boolean> {
  if (!(document as { prerendering?: boolean }).prerendering) return Promise.resolve(false);
  return new Promise((r) => document.addEventListener("prerenderingchange", () => r(true), { once: true }));
}

function build(cfg: WatchtowerConfig): Built {
  setUrlScrubbing(cfg.urlScrubbing);
  const session = new Session();
  const attrs: Attrs = syntheticAttrs();
  let remote: RemoteConfig = DEFAULT_REMOTE;
  let userHash: string | undefined;
  let userPending: Promise<void> = Promise.resolve();
  let stopped = false;
  let revoked = false;
  let paused = false;
  let lastErrorId: string | undefined;
  let onError: (() => void) | undefined;

  const rate = (): number => remote.sample_rate ?? cfg.sampleRate ?? 1;
  const errRate = (): number => remote.error_sample_rate ?? cfg.errorSampleRate ?? 1;

  const envelope = (): Envelope => ({
    session_id: session.id(),
    sent_at_ns: Date.now() * 1e6,
    sdk: { ...SDK },
    app: { service: cfg.service, release: cfg.release, env: cfg.environment },
    page: { url: scrubUrl(location.href), referrer: document.referrer ? scrubUrl(document.referrer) : undefined },
    device: {
      ua: navigator.userAgent,
      viewport: [window.innerWidth, window.innerHeight],
      dpr: window.devicePixelRatio,
    },
    user: { id_hash: userHash },
    attrs: { ...attrs, ...posthogAttrs(), ...lucidaAttrs(cfg.lucida), "wt.sample_rate": rate() },
  });

  const transport = new Transport({
    endpoint: cfg.endpoint,
    key: cfg.publishableKey,
    envelope,
    beforeFlush: () => userPending,
    offline: idbStore<RumEventV1>(),
    onReject: (status, n) => {
      if (cfg.debug) console.warn(`[watchtower] server refused ${n} events (HTTP ${status}); dropped and counted`);
    },
  });

  const emit = (type: RumEventV1["type"], name: string, extra: Partial<RumEventV1> = {}): void => {
    if (stopped || paused || !remote.rum_enabled) return;
    if (!session.sampled(rate()) && !(type === "error" && rand() < errRate())) return;
    let e: RumEventV1 | null = { id: uuid(), ts_ns: Date.now() * 1e6, type, name, attrs: {}, ...extra };
    if (cfg.beforeSend) e = cfg.beforeSend(e);
    if (!e) return;
    transport.push(e);
    if (type === "error") {
      lastErrorId = e.id;
      onError?.();
    }
  };

  // the edge forwards /v1/logs to the gateway, so the RUM endpoint is a working default
  const logs = new LogShipper(cfg.otlpEndpoint ?? cfg.endpoint, cfg.publishableKey, {
    "service.name": cfg.service,
    ...(cfg.release ? { "service.version": cfg.release } : {}),
    ...(cfg.environment ? { "deployment.environment.name": cfg.environment } : {}),
  }, idbStore<unknown>("wt-offline-logs"));
  // beforeSend sees the same `action`/`log` shape it always did, so existing scrubbers keep working
  const log = (level: LogLevel, message: string, at: Attrs = {}, span?: { trace_id?: string; span_id?: string }): void => {
    if (stopped || paused || !remote.rum_enabled || remote.browser_logs === false || !session.sampled(rate())) return;
    let e: RumEventV1 | null = { id: uuid(), ts_ns: Date.now() * 1e6, type: "action", name: "log",
      attrs: { ...at, "log.level": level, message: message.slice(0, 2048) } };
    if (cfg.beforeSend) e = cfg.beforeSend(e);
    if (!e) return;
    const { message: m, "log.level": lvl, ...rest } = e.attrs;
    logs.push((lvl ?? level) as LogLevel, String(m ?? ""), { ...attrs, ...posthogAttrs(), "session.id": session.id(), ...rest }, span);
  };

  const hashUser = (id: string | undefined): Promise<void> =>
    (id ? hashUserId(id, remote.id_salt ?? "") : Promise.resolve(undefined)).then(
      (h) => void (userHash = h),
      () => void (userHash = undefined),
    );

  const flushHidden = (): void => {
    if (document.visibilityState === "hidden") {
      transport.flushBeacon();
      void logs.flush();
    }
  };
  const onHide = (): void => {
    transport.flushBeacon();
    void logs.flush();
  };
  // bfcache restore: the session may have expired while the page was frozen
  const onShow = (e: Event): void => {
    if ((e as PageTransitionEvent).persisted) emit("nav", "bfcache_restore", { attrs: { "session.restored": true } });
  };
  document.addEventListener("visibilitychange", flushHidden);
  window.addEventListener("pagehide", onHide);
  window.addEventListener("pageshow", onShow);

  // a prerendered page sends nothing (and starts no session work) until the user sees it
  const ready = activated().then((pre) => {
    if (pre) attrs["page.prerendered"] = true;
    return fetchRemoteConfig(cfg.endpoint, cfg.publishableKey);
  }).then((r) => {
    remote = r;
    if (revoked) return; // a plain shutdown still starts the transport so it can flush what was queued
    if (cfg.posthog?.register) registerSession(session.id());
    transport.start();
  });

  // Recorder (rrweb) is a separate lazy chunk: only fetched when replay is on locally and remotely.
  const replayRemote = (r: RemoteConfig) => ({
    enabled: r.replay.enabled,
    maskLevel: (r.replay as { mask_level?: MaskLevel }).mask_level,
  });
  const replayReady: Promise<ReplayHandle | undefined> = ready
    .then(async () => {
      if (cfg.replay?.enabled !== true || !remote.replay.enabled) return undefined;
      const mod = await chunk(cfg.replay.scriptUrl, "replay.js", () => import("./replay/index.js"));
      const h = mod.startReplay({
        cfg: cfg.replay,
        remote: replayRemote(remote),
        endpoint: cfg.endpoint,
        key: cfg.publishableKey,
        sessionId: () => session.id(),
        sampled: (rate) => session.sampled(rate),
        errorSampled: (rate) => rand() < rate,
        refetchRemote: async () => replayRemote(await fetchRemoteConfig(cfg.endpoint, cfg.publishableKey)),
      });
      if (!stopped) h.auto();
      return h;
    })
    .catch(() => undefined);

  // Co-browse assist: a lazy chunk, only fetched when `assist.enabled` is set locally.
  let assist: { stop(): void } | undefined;
  void ready
    .then(async () => {
      if (cfg.assist?.enabled !== true || stopped) return;
      const mod = await chunk(cfg.assist.scriptUrl, "assist.js", () => import("./assist.js"));
      const r = cfg.replay;
      assist = mod.startAssist({
        cfg: cfg.assist, endpoint: cfg.endpoint, key: cfg.publishableKey, sessionId: () => session.id(),
        startReplay: () => void replayReady.then((h) => h?.start()),
        mask: () => mod.maskRules(r?.maskLevel, replayRemote(remote).maskLevel, r?.maskTextSelector, r?.blockSelector),
      });
    })
    .catch(() => undefined);

  const d = cfg.debug;
  const recordFlag = makeFlagRecorder(
    (key, at) => emit("flag", key, { attrs: at }),
    (k, v) => void (attrs[k] = v),
  );
  // Instrumentation (vitals, errors, tracing, ...) is a lazy chunk, like replay.
  let uninstall: Uninstall | undefined;
  void ready
    .then(async () => {
      if (stopped || !remote.rum_enabled) return;
      const mod = await chunk(cfg.instrumentUrl, "instrument/index.js", () => import("./instrument/index.js"));
      const u = await mod.install({ cfg, emit, log, sessionId: () => session.id(), extraAttrs: posthogAttrs,
        profilingEnabled: () => remote.profiling?.enabled ?? cfg.profiling === true,
        setAttribute: (k, v) => void (attrs[k] = v),
      });
      if (stopped) u();
      else uninstall = u;
    })
    .catch((e: unknown) => {
      if (cfg.debug) console.warn("[watchtower] instrumentation unavailable", e);
    });

  // Dynamic probes: a lazy chunk, only fetched when `probes.key` is configured.
  let probes: Promise<import("./probes").Probes | undefined> | undefined;
  const probe = safe((name: string, vars: () => Record<string, unknown>) => {
    if (!cfg.probes) return;
    probes ??= ready
      .then(async () => {
        const mod = await chunk(cfg.probes!.url, "probes.js", () => import("./probes.js"));
        const p = mod.createProbes({
          endpoint: cfg.endpoint, key: cfg.probes!.key, service: cfg.service, env: cfg.environment, version: cfg.release,
          emit: (n, at) => emit("action", n, { attrs: at }),
        });
        const tick = (): void => void p.poll().catch(() => undefined);
        tick();
        const timer = setInterval(tick, 30_000);
        (timer as { unref?: () => void }).unref?.();
        return p;
      })
      .catch(() => undefined);
    void probes.then((p) => p?.hit(name, vars));
  }, undefined, d);

  const stop = safe(() => {
    stopped = true;
    uninstall?.();
    assist?.stop();
    void replayReady.then((h) => h?.stop());
    document.removeEventListener("visibilitychange", flushHidden);
    window.removeEventListener("pagehide", onHide);
    window.removeEventListener("pageshow", onShow);
  }, undefined, d);

  // User feedback: a lazy chunk, fetched on the first `feedback` or `feedbackWidget` call.
  type FeedbackMod = typeof import("./feedback");
  let feedbackMod: Promise<FeedbackMod> | undefined;
  const loadFeedback = (): Promise<FeedbackMod> =>
    (feedbackMod ??= chunk(cfg.feedback?.scriptUrl, "feedback.js", () => import("./feedback.js")));
  const feedbackCtx = {
    endpoint: cfg.endpoint, key: cfg.publishableKey, sessionId: () => session.id(), lastErrorId: () => lastErrorId,
    flushReplay: () => replayReady.then((h) => h?.flush()),
  };

  const client: WatchtowerClient = {
    captureError: safe((err: unknown, ctx?: Attrs) => {
      const e = err instanceof Error ? err : new Error(String(err));
      void replayReady.then((h) => h?.trigger());
      emit("error", e.name, {
        attrs: {
          ...ctx,
          message: e.message.slice(0, 1024),
          stack: (e.stack ?? "").slice(0, 2000),
          handled: true,
        },
      });
    }, undefined, d),
    setUser: safe((u: { id?: string }) => {
      userPending = ready.then(() => hashUser(u.id));
    }, undefined, d),
    setAttribute: safe((k: string, v: string | number | boolean) => void (attrs[k] = v), undefined, d),
    journey: (name: string): Journey =>
      makeJourney(name, (n, at) => safe(() => emit("journey", n, { attrs: at }), undefined, d)()),
    flag: safe(recordFlag, undefined, d),
    log: safe((message: string, o?: { level?: LogLevel; attrs?: Attrs }) => log(o?.level ?? "info", String(message), o?.attrs), undefined, d),
    setView: safe((name: string) => {
      const n = String(name).slice(0, 128);
      attrs["view.name"] = n;
      emit("view", n, { attrs: { route: n } });
    }, undefined, d),
    pause: () => void (paused = true),
    unpause: () => void (paused = false),
    measure: safe((name: string, value: number, at?: Attrs) => {
      if (Number.isFinite(value)) emit("vital", `custom.${String(name).slice(0, 128)}`, { value, attrs: { ...at, "wt.kind": "measurement" } });
    }, undefined, d),
    event: safe((name: string, at?: Attrs) => emit("action", String(name).slice(0, 128), { attrs: { ...at, "wt.kind": "event" } }), undefined, d),
    probe,
    stop,
    replay: {
      start: safe(() => void replayReady.then((h) => h?.start()), undefined, d),
      stop: safe(() => void replayReady.then((h) => h?.stop()), undefined, d),
      flush: () => replayReady.then((h) => h?.flush()).then(() => undefined, () => undefined),
    },
    sessionId: safe(() => session.id(), "", d),
    feedback: (f) => Promise.resolve().then(loadFeedback).then((m) => m.sendFeedback(feedbackCtx, f)).catch(() => false),
    feedbackWidget: safe((o?: import("./feedback").FeedbackWidgetOptions) => {
      void loadFeedback().then((m) => {
        if (stopped) return;
        const w = m.mountWidget(feedbackCtx, o);
        let last = 0;
        if (o?.openOnError) {
          onError = () => {
            if (Date.now() - last < 60_000) return;
            last = Date.now();
            w.open(true);
          };
        }
      }).catch(() => undefined);
    }, undefined, d),
    shutdown: async () => {
      try {
        stop();
        await ready;
        await Promise.all([transport.shutdown(), logs.flush()]);
      } catch {
        /* never throws */
      }
    },
    grantConsent: noop,
    revokeConsent: noop,
  };

  if (cfg.user?.id) userPending = ready.then(() => hashUser(cfg.user?.id));
  cfg.flags?.forEach((a) => a.attach(client.flag));
  const revoke = (): void => {
    revoked = true;
    stop();
    transport.discard();
    logs.discard();
    session.clear();
  };
  return { client, revoke };
}

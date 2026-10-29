import {
  DEFAULT_REMOTE,
  SDK,
  type Attrs,
  type RemoteConfig,
  type RumEventV1,
  type WatchtowerConfig,
} from "./config";
import { hashUserId, rand, uuid } from "./ids";
import { posthogAttrs, registerSession } from "./posthog";
import type { Uninstall } from "./instrument/ctx";
import { makeFlagRecorder } from "./instrument/flags";
import { makeJourney, type Journey } from "./instrument/journeys";
import { fetchRemoteConfig } from "./remote_config";
import type { ReplayHandle } from "./replay";
import type { MaskLevel } from "./replay/config";
import { idbStore } from "./queue";
import { Session } from "./session";
import { Transport, type Envelope } from "./transport";

export type { RumEventV1, WatchtowerConfig, ReplayConfig, FlagAdapter } from "./config";

export type { Journey };
export { growthBookAdapter, launchDarklyAdapter, openFeatureHook } from "./instrument/flags";

export interface WatchtowerClient {
  captureError(err: unknown, ctx?: Attrs): void;
  setUser(u: { id?: string }): void;
  setAttribute(k: string, v: string | number | boolean): void;
  journey(name: string): Journey;
  flag(key: string, value: unknown): void;
  /** Dynamic probe point: `vars` runs only while an active probe targets `name` (needs `probes.key`). */
  probe(name: string, vars: () => Record<string, unknown>): void;
  stop(): void;
  replay: { start(): void; stop(): void; flush(): Promise<void> };
  sessionId(): string;
  shutdown(): Promise<void>;
}

const noop = (): void => undefined;
const NOOP_CLIENT: WatchtowerClient = {
  captureError: noop,
  setUser: noop,
  setAttribute: noop,
  journey: () => ({ step: noop, fail: noop }),
  flag: noop,
  probe: noop,
  stop: noop,
  replay: { start: noop, stop: noop, flush: () => Promise.resolve() },
  sessionId: () => "",
  shutdown: () => Promise.resolve(),
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
    return build(cfg);
  } catch (e) {
    if (cfg?.debug) console.warn("[watchtower] init failed", e);
    return NOOP_CLIENT;
  }
}

function build(cfg: WatchtowerConfig): WatchtowerClient {
  const session = new Session();
  const attrs: Attrs = {};
  let remote: RemoteConfig = DEFAULT_REMOTE;
  let userHash: string | undefined;
  let userPending: Promise<void> = Promise.resolve();
  let stopped = false;

  const rate = (): number => remote.sample_rate ?? cfg.sampleRate ?? 1;
  const errRate = (): number => remote.error_sample_rate ?? cfg.errorSampleRate ?? 1;

  const envelope = (): Envelope => ({
    session_id: session.id(),
    sent_at_ns: Date.now() * 1e6,
    sdk: { ...SDK },
    app: { service: cfg.service, release: cfg.release, env: cfg.environment },
    // fragment dropped: it can carry tokens
    page: { url: location.href.split("#")[0]!, referrer: document.referrer || undefined },
    device: {
      ua: navigator.userAgent,
      viewport: [window.innerWidth, window.innerHeight],
      dpr: window.devicePixelRatio,
    },
    user: { id_hash: userHash },
    attrs: { ...attrs, ...posthogAttrs(), "wt.sample_rate": rate() },
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
    if (stopped || !remote.rum_enabled) return;
    if (!session.sampled(rate()) && !(type === "error" && rand() < errRate())) return;
    let e: RumEventV1 | null = { id: uuid(), ts_ns: Date.now() * 1e6, type, name, attrs: {}, ...extra };
    if (cfg.beforeSend) e = cfg.beforeSend(e);
    if (e) transport.push(e);
  };

  const hashUser = (id: string | undefined): Promise<void> =>
    (id ? hashUserId(id, remote.id_salt ?? "") : Promise.resolve(undefined)).then(
      (h) => void (userHash = h),
      () => void (userHash = undefined),
    );

  const flushHidden = (): void => {
    if (document.visibilityState === "hidden") transport.flushBeacon();
  };
  const onHide = (): void => transport.flushBeacon();
  document.addEventListener("visibilitychange", flushHidden);
  window.addEventListener("pagehide", onHide);

  const ready = fetchRemoteConfig(cfg.endpoint, cfg.publishableKey).then((r) => {
    remote = r;
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
      const url = cfg.replay.scriptUrl ?? new URL("replay.js", import.meta.url).href;
      const mod = (await import(/* @vite-ignore */ url)) as typeof import("./replay");
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
      const url = cfg.instrumentUrl ?? new URL("instrument/index.js", import.meta.url).href;
      const mod = (await import(/* @vite-ignore */ url)) as typeof import("./instrument");
      const u = await mod.install({ cfg, emit, sessionId: () => session.id(), extraAttrs: posthogAttrs,
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
        const mod = (await import(/* @vite-ignore */ cfg.probes!.url ?? new URL("probes.js", import.meta.url).href)) as typeof import("./probes");
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
    void replayReady.then((h) => h?.stop());
    document.removeEventListener("visibilitychange", flushHidden);
    window.removeEventListener("pagehide", onHide);
  }, undefined, d);

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
    probe,
    stop,
    replay: {
      start: safe(() => void replayReady.then((h) => h?.start()), undefined, d),
      stop: safe(() => void replayReady.then((h) => h?.stop()), undefined, d),
      flush: () => replayReady.then((h) => h?.flush()).then(() => undefined, () => undefined),
    },
    sessionId: safe(() => session.id(), "", d),
    shutdown: async () => {
      try {
        stop();
        await ready;
        await transport.shutdown();
      } catch {
        /* never throws */
      }
    },
  };

  if (cfg.user?.id) userPending = ready.then(() => hashUser(cfg.user?.id));
  cfg.flags?.forEach((a) => a.attach(client.flag));
  return client;
}

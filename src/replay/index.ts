import { record } from "rrweb";
import { RingBuffer } from "./buffer";
import { Chunker, type StopReason } from "./chunker";
import { canvasAllowed, videoFramePlugin } from "./canvas";
import { effectiveLevel, REPLAY_LIMITS, type MaskLevel, type ReplayConfig, type ReplayRemote, type RrEvent } from "./config";
import { buildRecordOptions, Sanitizer } from "./privacy";
import { RouteGuard } from "./routes";

export * from "./plugins";
export type { ReplayConfig, ReplayPlugin, RrEvent } from "./config";

export interface ReplayDeps {
  cfg: ReplayConfig;
  remote: ReplayRemote;
  endpoint: string;
  key: string;
  sessionId: () => string;
  /** session-level draw shared with RUM sampling, so replay and RUM agree */
  sampled: (rate: number) => boolean;
  /** independent draw for error-triggered recording */
  errorSampled: (rate: number) => boolean;
  flags?: () => Record<string, unknown>;
  /** re-fetch the project replay config (after a 422 mask floor answer) */
  refetchRemote?: () => Promise<ReplayRemote>;
  f?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface ReplayHandle {
  /** apply the sampling decision and start (what the SDK calls after init) */
  auto(): void;
  /** manual control: record the whole session from now */
  start(): void;
  stop(): void;
  flush(): Promise<void>;
  /** an error or rage click happened: flush the buffered past and keep recording */
  trigger(): void;
  setRemote(r: ReplayRemote): void;
  recording(): boolean;
}

type Mode = "full" | "buffer";

export function startReplay(d: ReplayDeps): ReplayHandle {
  const { cfg } = d;
  let remote = d.remote;
  let level: MaskLevel = effectiveLevel(cfg.maskLevel, remote.maskLevel);
  let stopRec: (() => void) | undefined;
  let stopPlugins: (() => void)[] = [];
  let mode: Mode = "full";
  let chunker: Chunker | undefined;
  let ring: RingBuffer | undefined;
  let routes: RouteGuard | undefined;
  let sanitizer = new Sanitizer();
  let paused = false;
  let refetched = false;
  let clicks: number[] = [];
  let drain: Promise<void> = Promise.resolve();

  const allowed = (): boolean => cfg.enabled !== false && remote.enabled;
  const windowMs = (cfg.errorBufferSeconds ?? 60) * 1000;

  const sink = (e: RrEvent, checkout: boolean): void => {
    if (mode === "buffer") ring?.push(e, checkout);
    else chunker?.add(e, checkout);
  };

  const onEvent = (raw: RrEvent, checkout?: boolean): void => {
    if (paused) return;
    let e: RrEvent | null = sanitizer.apply(routes ? routes.rewrite(raw) : raw);
    if (cfg.beforeAddEvent) e = cfg.beforeAddEvent(e);
    if (!e) return;
    sink(sanitizer.apply(e), checkout === true);
  };

  const onClick = (): void => {
    const t = Date.now();
    clicks = [...clicks.filter((c) => t - c < 1000), t];
    if (clicks.length >= 3) {
      clicks = [];
      handle.trigger();
    }
  };
  const onWinError = (): void => handle.trigger();
  const onHide = (): void => chunker?.flushBeacon();

  const stop = (): void => {
    if (!stopRec && !chunker) return;
    stopRec?.();
    stopRec = undefined;
    stopPlugins.forEach((s) => s());
    stopPlugins = [];
    routes?.stop();
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("error", onWinError);
    window.removeEventListener("pagehide", onHide);
    drain = chunker?.flush() ?? drain;
    chunker = undefined;
    ring = undefined;
    cfg.onStop?.();
  };

  const onChunkerStop = (why: StopReason): void => {
    stop();
    if (why === "floor" && !refetched && d.refetchRemote) {
      refetched = true;
      void d.refetchRemote().then((r) => {
        remote = r;
        level = effectiveLevel(cfg.maskLevel, r.maskLevel);
        if (allowed()) begin("full");
      }, () => undefined);
    }
  };

  const begin = (m: Mode): void => {
    if (stopRec || !allowed()) return;
    const flags = d.flags?.() ?? {};
    if (cfg.shouldRecord && !cfg.shouldRecord({ route: location.pathname, session: d.sessionId(), flags })) return;
    mode = m;
    sanitizer = new Sanitizer();
    chunker = new Chunker({
      endpoint: d.endpoint,
      key: d.key,
      session: d.sessionId,
      level,
      f: d.f,
      sleep: d.sleep,
      onChunk: cfg.onChunk,
      onDrop: () => {
        try {
          record.addCustomEvent("wt.replay.dropped", {});
        } catch {
          /* recorder already stopped */
        }
      },
      onStop: onChunkerStop,
    });
    ring = m === "buffer" ? new RingBuffer(windowMs) : undefined;

    routes = new RouteGuard(cfg.excludeRoutes ?? [], (ex) => {
      if (ex) {
        // tell the player recording paused (no route name), then drop everything until the route is left
        paused = false;
        if (stopRec) record.addCustomEvent("wt.replay.paused", {});
        paused = true;
      } else {
        const was = paused;
        paused = false;
        if (was && stopRec) record.takeFullSnapshot(true);
      }
    });
    // startup exclusion must be known before rrweb's first snapshot
    paused = routes.excluded();

    const opts = buildRecordOptions(cfg, level);
    if (m === "buffer") opts.checkoutEveryNms = Math.max(1000, windowMs / 2);
    else opts.checkoutEveryNms ??= REPLAY_LIMITS.checkoutMs;
    stopRec = record({ ...opts, emit: onEvent } as Parameters<typeof record>[0]);
    routes.start();
    record.addCustomEvent("wt.rum.session", { session_id: d.sessionId() });
    const plugins = [...(cfg.plugins ?? [])];
    if (cfg.recordVideoFrames === true && canvasAllowed(true, level)) plugins.push(videoFramePlugin());
    for (const p of plugins) {
      stopPlugins.push(p.start((payload) => record.addCustomEvent(`wt.plugin.${p.name}`, payload)));
    }
    window.addEventListener("click", onClick, true);
    window.addEventListener("error", onWinError);
    window.addEventListener("pagehide", onHide);
    cfg.onStart?.();
  };

  const handle: ReplayHandle = {
    auto() {
      if (!allowed()) return;
      if (d.sampled(cfg.sampleRate ?? 0.1)) begin("full");
      else if ((cfg.errorSampleRate ?? 1) > 0 && d.errorSampled(cfg.errorSampleRate ?? 1)) begin("buffer");
    },
    start: () => begin("full"),
    stop,
    flush: () => (chunker ? chunker.flush() : drain),
    trigger() {
      if (mode !== "buffer" || !ring || !chunker) return;
      mode = "full";
      const c = chunker;
      ring.drain().forEach((e) => c.add(e));
      ring = undefined;
    },
    setRemote(r) {
      remote = r;
      if (!allowed()) stop();
    },
    recording: () => !!stopRec,
  };
  return handle;
}

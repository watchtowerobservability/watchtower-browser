export type Attrs = Record<string, string | number | boolean>;
export type Matcher = string | RegExp;

export interface RumEventV1 {
  id: string;
  ts_ns: number;
  type: "view" | "vital" | "error" | "resource" | "action" | "longtask" | "journey" | "frustration" | "flag" | "nav" | "db" | "storage";
  name: string;
  value?: number;
  attrs: Attrs;
  /** lowercase hex, 32 chars (OTel JSON form) */
  trace_id?: string;
  /** lowercase hex, 16 chars */
  span_id?: string;
}

/** Passed to `client.on("error", cb)`. `event_id` is the RUM event id ingest stores. */
export interface WtErrorEvent {
  event_id: string;
  trace_id?: string;
  fingerprint?: string;
  message: string;
  type?: string;
  handled: boolean;
  url: string;
  ts: number;
}

/** Passed to `client.on("vital", cb)`. */
export interface WtVital {
  name: "LCP" | "INP" | "CLS" | "FCP" | "TTFB";
  value: number;
  rating: "good" | "needs-improvement" | "poor";
  navigation_id: string;
  url: string;
  final: boolean;
}

import type { ReplayConfig } from "./replay/config";
import type { AssistConfig } from "./assist";
export type { ReplayConfig };

export interface FlagAdapter {
  name: string;
  attach(record: (key: string, value: unknown) => void): void;
}

export interface WatchtowerConfig {
  publishableKey: string;
  /** edge base URL */
  endpoint: string;
  /** gateway base URL for OTLP traces */
  otlpEndpoint?: string;
  service: string;
  release?: string;
  environment?: string;
  /** traceparent is injected only into requests matching these (string = URL prefix); default none */
  propagateTo?: Matcher[];
  /** URL of the lazy instrumentation chunk (default: instrument/index.js beside the core) */
  instrumentUrl?: string;
  /** capture console.error as error events (default off) */
  captureConsoleErrors?: boolean;
  /** console levels sent as OTLP log records with the session id (default none) */
  captureConsole?: Array<"debug" | "log" | "info" | "warn" | "error">;
  /** automatic user-action spans: a click, submit or Enter starts a span that parents the fetch/XHR
   * spans it causes (needs otlpEndpoint; default on). Name one with `data-wt-action="checkout"`. */
  userActions?: boolean;
  /** name an auto action after the clicked element's text (<= 128 chars) when it has no `data-wt-action`.
   * Default false: names are a selector (tag, id, classes, `data-testid`, `name`), because element text
   * can hold names and emails. */
  actionNameFromText?: boolean;
  sampleRate?: number;
  errorSampleRate?: number;
  ignoreUrls?: Matcher[];
  /** default on: reported URLs (page, resource, fetch/XHR spans) lose their query string and fragment, and
   * path segments that look like secrets (UUIDs, hex runs, JWTs, long digit runs, random tokens of >= 16 chars) become `:redacted`; hosts and readable words, slugs and short ids stay.
   * `false` keeps query strings and path ids (the fragment is always dropped).
   * Presets (same names as the node SDK's `redact`): `"strict"` = `true`; `"pii"` also redacts emails, phone numbers, card numbers and IPv4 addresses in path segments; `"off"` = `false`. */
  urlScrubbing?: boolean | "strict" | "pii" | "off" | { allow?: RegExp[]; deny?: RegExp[] };
  /** an object with `getSessionId()` (the Lucida browser SDK client); used before `globalThis.lucida` */
  lucida?: { getSessionId?: () => string; getDistinctId?: () => string } | (() => { getSessionId?: () => string; getDistinctId?: () => string } | undefined);
  beforeSend?: (e: RumEventV1) => RumEventV1 | null;
  /** hashed client-side (SHA-256 + project salt) before send */
  user?: { id?: string };
  replay?: ReplayConfig;
  /** co-browse assist (off by default; the project must turn it on too); `scriptUrl` defaults to assist.js beside the core */
  assist?: AssistConfig & { scriptUrl?: string };
  /** remote control of the page during an assist: off unless `allowControl` is true here (or on `assist`); the project and the end user must agree too */
  cobrowse?: { allowControl?: boolean };
  profiling?: boolean;
  /** opt-in client storage monitoring (IndexedDB, Cache Storage, localStorage, quota; sql.js/wa-sqlite via
   * the `/storage` entry): slow or failed operations as `db` events, sizes as `storage` events. A lazy chunk. */
  storage?: boolean | StorageConfig;
  flags?: FlagAdapter[];
  posthog?: { register?: boolean };
  /** dynamic probes: an ingestion key with scope `probes:read`, and the lazy chunk URL (default probes.js beside the core) */
  probes?: { key: string; url?: string };
  /** user feedback (ERR-014): the lazy chunk URL, default feedback.js beside the core */
  feedback?: { scriptUrl?: string };
  /** "pending": nothing runs or is sent (no session, no config fetch) until `grantConsent()`. Default "granted".
   * While pending, up to 100 calls (`captureError`, `event`, `measure`, `log`, `flag`, `setUser`, `setAttribute`, `setView`) are held in memory and
   * replayed in order on `grantConsent()` (their timestamps are the replay time); `revokeConsent()` drops them. */
  consent?: "pending" | "granted";
  /** opt-in: keep an anonymous id in localStorage (`wt.anon`, sent as the `wt.anon_id` attribute) so it survives sessions. Default off: no id beyond the per-tab session. Removed by revokeConsent(). */
  persistAnonId?: boolean;
  /** set `globalThis[name]` to the client and dispatch `watchtower:ready` on window. `true` = "watchtower".
   * Default: on for the script (IIFE) build, off for npm/ESM. `false` turns the script default off. */
  exposeGlobal?: boolean | string;
  debug?: boolean;
}

export interface StorageConfig {
  /** async operations at or over this many ms are reported (default 100); sync main-thread work uses 16 ms, one frame */
  slowMs?: number;
  /** quota and size sample interval (default 300000; 0 = only once at start) */
  sampleMs?: number;
}

export interface RemoteConfig {
  rum_enabled: boolean;
  /** the project's switch for browser log records */
  browser_logs?: boolean;
  sample_rate?: number;
  error_sample_rate?: number;
  /** project salt for client-side user-id hashing */
  id_salt?: string;
  replay: { enabled: boolean; mask_level?: "strict" | "balanced" | "relaxed" };
  profiling?: { enabled?: boolean };
}

/** Safe defaults when the config endpoint is unreachable: RUM on, replay off. */
export const DEFAULT_REMOTE: RemoteConfig = { rum_enabled: true, replay: { enabled: false } };

export const LIMITS = {
  flushEvents: 50,
  flushMs: 5000,
  queueMax: 500,
  gzipMinBytes: 1024,
  backoffMaxMs: 60_000,
  idleMs: 30 * 60_000,
  maxSessionMs: 4 * 3_600_000,
  configTimeoutMs: 2000,
} as const;

/** Replaced with package.json's version by esbuild (and vitest) at build time. */
declare const __WT_VERSION__: string;
// esbuild and vitest define it from package.json; an app that bundles the source (apps/web) does not
export const SDK = { name: "@watchtowerobservability/browser", version: typeof __WT_VERSION__ === "string" ? __WT_VERSION__ : "source" } as const;

const loadScript = typeof document === "undefined" ? null : (document.currentScript as HTMLScriptElement | null);

/** The release when `init` has none: `data-release` on the loading script tag (or any script
 * tag), `<meta name="wt-release">`, or a build-injected `__WT_RELEASE__` / `__WATCHTOWER_RELEASE__`. */
export function defaultRelease(): string | undefined {
  try {
    const g = globalThis as { __WT_RELEASE__?: unknown; __WATCHTOWER_RELEASE__?: unknown };
    const found =
      loadScript?.dataset?.release ||
      document.querySelector<HTMLScriptElement>("script[data-release]")?.dataset.release ||
      document.querySelector<HTMLMetaElement>('meta[name="wt-release"]')?.content ||
      (typeof g.__WT_RELEASE__ === "string" ? g.__WT_RELEASE__ : "") ||
      (typeof g.__WATCHTOWER_RELEASE__ === "string" ? g.__WATCHTOWER_RELEASE__ : "");
    return found?.trim() || undefined;
  } catch {
    return undefined;
  }
}

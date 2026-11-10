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
  sampleRate?: number;
  errorSampleRate?: number;
  ignoreUrls?: Matcher[];
  /** default on: reported URLs (page, resource, fetch/XHR spans) lose their query string and fragment, and
   * secret-looking path segments (UUIDs, >= 24 chars, or >= 10 chars with a letter and a digit) become `:redacted`.
   * `false` keeps query strings and path ids (the fragment is always dropped). */
  urlScrubbing?: boolean;
  /** an object with `getSessionId()` (the Lucida browser SDK client); used before `globalThis.lucida` */
  lucida?: { getSessionId?: () => string };
  beforeSend?: (e: RumEventV1) => RumEventV1 | null;
  /** hashed client-side (SHA-256 + project salt) before send */
  user?: { id?: string };
  replay?: ReplayConfig;
  /** co-browse assist (off by default; the project must turn it on too); `scriptUrl` defaults to assist.js beside the core */
  assist?: AssistConfig & { scriptUrl?: string };
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
  /** "pending": nothing runs or is sent (no session, no config fetch) until `grantConsent()`. Default "granted". */
  consent?: "pending" | "granted";
  /** opt-in: keep an anonymous id in localStorage (default off) */
  persistAnonId?: boolean;
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

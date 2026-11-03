export type Attrs = Record<string, string | number | boolean>;
export type Matcher = string | RegExp;

export interface RumEventV1 {
  id: string;
  ts_ns: number;
  type: "view" | "vital" | "error" | "resource" | "action" | "longtask" | "journey" | "frustration" | "flag" | "nav";
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
  beforeSend?: (e: RumEventV1) => RumEventV1 | null;
  /** hashed client-side (SHA-256 + project salt) before send */
  user?: { id?: string };
  replay?: ReplayConfig;
  /** co-browse assist (off by default; the project must turn it on too); `scriptUrl` defaults to assist.js beside the core */
  assist?: AssistConfig & { scriptUrl?: string };
  profiling?: boolean;
  flags?: FlagAdapter[];
  posthog?: { register?: boolean };
  /** dynamic probes: an ingestion key with scope `probes:read`, and the lazy chunk URL (default probes.js beside the core) */
  probes?: { key: string; url?: string };
  /** user feedback (ERR-014): the lazy chunk URL, default feedback.js beside the core */
  feedback?: { scriptUrl?: string };
  /** opt-in: keep an anonymous id in localStorage (default off) */
  persistAnonId?: boolean;
  debug?: boolean;
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

export const SDK = { name: "@watchtower/browser", version: "0.1.0" } as const;

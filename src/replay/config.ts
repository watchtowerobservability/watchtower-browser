export type MaskLevel = "strict" | "balanced" | "relaxed";

/** Minimal rrweb event shape (avoids a type dependency; rrweb types are structurally compatible). */
export interface RrEvent {
  type: number;
  timestamp: number;
  data: any;
}

export interface ReplayPlugin {
  name: string;
  /** Start capturing; `emit` records a plugin event through the privacy pipeline. Returns a stop function. */
  start(emit: (payload: unknown) => void): () => void;
}

export interface ReplayConfig {
  enabled?: boolean;
  maskLevel?: MaskLevel;
  maskTextSelector?: string;
  blockSelector?: string;
  unmaskSelector?: string;
  excludeRoutes?: (string | RegExp)[];
  sampleRate?: number;
  errorSampleRate?: number;
  errorBufferSeconds?: number;
  recordCanvas?: boolean;
  /** sample `<video>` frames (opt-in, never under strict, blocked elements skipped); WebGL is covered by `recordCanvas` */
  recordVideoFrames?: boolean;
  recordCrossOriginIframes?: boolean;
  collectFonts?: boolean;
  plugins?: ReplayPlugin[];
  shouldRecord?: (ctx: { route: string; session: string; flags: Record<string, unknown> }) => boolean;
  beforeAddEvent?: (e: RrEvent) => RrEvent | null;
  /** full snapshot interval, default 60000 */
  checkoutEveryNms?: number;
  onChunk?: (info: { seq: number; bytes: number; events: number }) => void;
  onStart?: () => void;
  onStop?: () => void;
  /** URL of the lazily loaded recorder chunk (default: `replay.js` next to the SDK module) */
  scriptUrl?: string;
}

export interface ReplayRemote {
  enabled: boolean;
  /** server-side minimum mask level, if the project config carries one */
  maskLevel?: MaskLevel;
}

export const REPLAY_LIMITS = {
  chunkMaxBytes: 900 * 1024,
  chunkMs: 5000,
  bufferMaxBytes: 5 * 1024 * 1024,
  maxRetries: 5,
  beaconMaxBytes: 60 * 1024,
  stateMaxBytes: 32 * 1024,
  checkoutMs: 60_000,
} as const;

const RANK: Record<MaskLevel, number> = { relaxed: 0, balanced: 1, strict: 2 };

/** Local config can only tighten the remote level: the stricter of the two wins. Default is strict. */
export function effectiveLevel(local: MaskLevel | undefined, remote: MaskLevel | undefined): MaskLevel {
  const l = local ?? "strict";
  return remote && RANK[remote] > RANK[l] ? remote : l;
}

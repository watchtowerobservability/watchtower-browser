import type { ProfilerTrace } from "./folded";

export interface RunningProfiler {
  stop(): Promise<ProfilerTrace>;
}
export type ProfilerCtor = new (o: { sampleInterval: number; maxBufferSize: number }) => RunningProfiler;

export const SAMPLE_INTERVAL_MS = 10;
export const MAX_BUFFER = 10_000;

/** The JS Self-Profiling API; also needs the `Document-Policy: js-profiling` response header. */
export const profilerCtor = (): ProfilerCtor | undefined => {
  const P = (globalThis as { Profiler?: unknown }).Profiler;
  return typeof P === "function" ? (P as ProfilerCtor) : undefined;
};

/** Start sampling; throws when the document policy forbids it (caller treats that as unsupported). */
export function startProfiler(P: ProfilerCtor): RunningProfiler {
  return new P({ sampleInterval: SAMPLE_INTERVAL_MS, maxBufferSize: MAX_BUFFER });
}

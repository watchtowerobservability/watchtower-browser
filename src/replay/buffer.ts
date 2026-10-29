import { REPLAY_LIMITS, type RrEvent } from "./config";

interface Seg {
  events: RrEvent[];
  bytes: number;
}

/**
 * Rolling in-memory buffer for error-triggered replay. Events are grouped in segments that start at a
 * full-snapshot checkout, so a drain always begins with a snapshot. The oldest segment drops once the next
 * one already covers the window, or when the total exceeds the byte cap.
 */
export class RingBuffer {
  private segs: Seg[] = [{ events: [], bytes: 0 }];
  constructor(
    private windowMs: number,
    private maxBytes: number = REPLAY_LIMITS.bufferMaxBytes,
  ) {}

  push(e: RrEvent, checkout: boolean): void {
    if (checkout) this.segs.push({ events: [], bytes: 0 });
    const s = this.segs[this.segs.length - 1]!;
    s.events.push(e);
    s.bytes += JSON.stringify(e).length;
    this.prune(e.timestamp);
  }

  private prune(now: number): void {
    while (this.segs.length > 1) {
      const next = this.segs[1]!.events[0];
      if ((next && next.timestamp <= now - this.windowMs) || this.size() > this.maxBytes) this.segs.shift();
      else break;
    }
  }

  /** Returns all buffered events and empties the buffer. */
  drain(): RrEvent[] {
    const out = this.segs.flatMap((s) => s.events);
    this.segs = [{ events: [], bytes: 0 }];
    return out;
  }

  size(): number {
    return this.segs.reduce((n, s) => n + s.bytes, 0);
  }
}

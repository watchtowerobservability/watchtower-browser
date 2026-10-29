import { gzipSync, strToU8 } from "fflate";
import { SDK } from "../config";
import { REPLAY_LIMITS, type MaskLevel, type RrEvent } from "./config";

export type StopReason = "disabled" | "session_cap" | "floor";

export interface ChunkerOpts {
  endpoint: string;
  key: string;
  session: () => string;
  level: MaskLevel;
  f?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onChunk?: (info: { seq: number; bytes: number; events: number }) => void;
  /** a chunk was given up on after the retries; the recording has a gap */
  onDrop?: () => void;
  onStop?: (why: StopReason) => void;
}

const RAW_FLUSH_BYTES = 3 * 1024 * 1024;

/**
 * Batches events into gzip chunks (<= 900 KiB compressed, or every 5 s) and POSTs them in order with a strictly
 * increasing `seq`. A failed chunk is retried with the same `seq` (the server is idempotent) and dropped after 5 retries.
 */
export class Chunker {
  private pending: string[] = [];
  private rawBytes = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private chain: Promise<void> = Promise.resolve();
  private seq = 0;
  private session = "";
  stopped = false;

  constructor(private o: ChunkerOpts) {}

  add(e: RrEvent, checkout = false): void {
    if (this.stopped) return;
    if (checkout) this.flush();
    const s = JSON.stringify(e);
    this.pending.push(s);
    this.rawBytes += s.length;
    if (this.rawBytes >= RAW_FLUSH_BYTES) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), REPLAY_LIMITS.chunkMs);
  }

  /** Queue what is pending; resolves when the upload queue is drained. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const events = this.pending;
    this.pending = [];
    this.rawBytes = 0;
    if (events.length) {
      const id = this.session || (this.session = this.o.session());
      this.chain = this.chain.then(() => this.sendAll(id, events));
    }
    return this.chain;
  }

  /** Sync best-effort flush for pagehide: keepalive fetch (needs headers), <= 60 KiB, remainder dropped. */
  flushBeacon(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const events = this.pending;
    this.pending = [];
    this.rawBytes = 0;
    if (this.stopped || !events.length) return;
    const body = gzipSync(strToU8(`[${events.join(",")}]`));
    if (body.length > REPLAY_LIMITS.beaconMaxBytes) return;
    // seq claimed synchronously; queued sends will take the next numbers
    const seq = this.seq++;
    void this.post(this.session || this.o.session(), seq, body, true).catch(() => undefined);
  }

  private async sendAll(session: string, events: string[]): Promise<void> {
    if (this.stopped) return;
    const body = gzipSync(strToU8(`[${events.join(",")}]`));
    if (body.length > REPLAY_LIMITS.chunkMaxBytes && events.length > 1) {
      const mid = events.length >> 1;
      await this.sendAll(session, events.slice(0, mid));
      await this.sendAll(session, events.slice(mid));
      return;
    }
    const seq = this.seq++;
    for (let attempt = 0; attempt <= REPLAY_LIMITS.maxRetries; attempt++) {
      if (this.stopped) return;
      if (attempt) await (this.o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(Math.min(500 * 2 ** attempt, 15_000));
      try {
        const r = await this.post(session, seq, body, false);
        if (r.ok) {
          this.o.onChunk?.({ seq, bytes: body.length, events: events.length });
          return;
        }
        if (this.fatal(r.status, await r.text().catch(() => ""))) return;
      } catch {
        /* network error: retry same seq */
      }
    }
    this.o.onDrop?.();
  }

  /** Statuses that end the recording rather than retry. */
  private fatal(status: number, text: string): boolean {
    const why: StopReason | undefined =
      status === 403 ? "disabled" : status === 413 ? "session_cap" : status === 422 && text.includes("mask_level_below_floor") ? "floor" : undefined;
    if (!why) return false;
    this.stopped = true;
    this.pending = [];
    this.o.onStop?.(why);
    return true;
  }

  private post(session: string, seq: number, body: Uint8Array, keepalive: boolean): Promise<Response> {
    const f = this.o.f ?? globalThis.fetch.bind(globalThis);
    return f(`${this.o.endpoint.replace(/\/$/, "")}/v1/replay/${session}/chunks?seq=${seq}`, {
      method: "POST",
      body,
      keepalive,
      headers: {
        Authorization: `Bearer ${this.o.key}`,
        "Content-Encoding": "gzip",
        "Content-Type": "application/json",
        "X-WT-Mask": this.o.level,
        "X-WT-Sdk": `${SDK.name}/${SDK.version}`,
      },
    });
  }
}

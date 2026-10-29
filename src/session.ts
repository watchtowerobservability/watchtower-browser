import { LIMITS } from "./config";
import { rand, uuid } from "./ids";

interface Stored {
  id: string;
  start: number;
  last: number;
  /** sampling draw in [0,1); decision = draw < rate, stable for the session */
  draw: number;
}

const KEY = "wt.session";

/** UUIDv4 session in sessionStorage (memory fallback), 30 min idle and 4 h max rollover. No cookies. */
export class Session {
  private mem?: Stored;
  constructor(private now: () => number = Date.now) {}

  private read(): Stored | undefined {
    try {
      const raw = globalThis.sessionStorage?.getItem(KEY);
      if (raw) return JSON.parse(raw) as Stored;
    } catch {
      /* blocked storage */
    }
    return this.mem;
  }

  private write(s: Stored): void {
    this.mem = s;
    try {
      globalThis.sessionStorage?.setItem(KEY, JSON.stringify(s));
    } catch {
      /* memory only */
    }
  }

  /** Current session, rolled over when idle or too old; counts as activity. */
  touch(): Stored {
    const t = this.now();
    let s = this.read();
    if (!s || t - s.last > LIMITS.idleMs || t - s.start > LIMITS.maxSessionMs) {
      s = { id: uuid(), start: t, last: t, draw: rand() };
    } else {
      s = { ...s, last: t };
    }
    this.write(s);
    return s;
  }

  id(): string {
    return this.touch().id;
  }

  sampled(rate: number): boolean {
    return this.touch().draw < rate;
  }
}

import { LIMITS } from "./config.js";
import { rand, uuid } from "./ids.js";

interface Stored {
  id: string;
  start: number;
  last: number;
  /** sampling draw in [0,1); decision = draw < rate, stable for the session */
  draw: number;
}

const KEY = "wt.session";
const ANON_KEY = "wt.anon";

/** UUIDv4 session in sessionStorage (memory fallback), 30 min idle and 4 h max rollover. No cookies. */
export class Session {
  private mem?: Stored;
  private anon?: string;
  constructor(private now: () => number = Date.now, private persistAnon = false) {}

  /** Anonymous id kept in localStorage across sessions (opt-in `persistAnonId`); undefined when off. Falls back to memory when storage is blocked. */
  anonId(): string | undefined {
    if (!this.persistAnon) return undefined;
    try {
      const v = globalThis.localStorage?.getItem(ANON_KEY);
      if (v) return (this.anon = v);
    } catch {
      /* blocked storage */
    }
    this.anon ??= uuid();
    try {
      globalThis.localStorage?.setItem(ANON_KEY, this.anon);
    } catch {
      /* memory only */
    }
    return this.anon;
  }

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

  /** Consent revoked: forget the session id and the persisted anonymous id. */
  clear(): void {
    this.mem = undefined;
    this.anon = undefined;
    try {
      globalThis.localStorage?.removeItem(ANON_KEY);
    } catch {
      /* blocked storage */
    }
    try {
      globalThis.sessionStorage?.removeItem(KEY);
    } catch {
      /* blocked storage */
    }
  }

  id(): string {
    return this.touch().id;
  }

  sampled(rate: number): boolean {
    return this.touch().draw < rate;
  }
}

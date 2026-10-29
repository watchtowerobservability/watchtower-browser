/** Bounded FIFO: when full the oldest event is dropped and counted. */
export class BoundedQueue<T> {
  private items: T[] = [];
  dropped = 0;
  constructor(private max: number) {}

  push(item: T): void {
    this.items.push(item);
    this.trim();
  }

  /** Put a failed batch back in front (still bounded). */
  requeue(items: T[]): void {
    this.items = items.concat(this.items);
    this.trim();
  }

  take(n: number): T[] {
    return this.items.splice(0, n);
  }

  get length(): number {
    return this.items.length;
  }

  private trim(): void {
    const over = this.items.length - this.max;
    if (over > 0) {
      this.items.splice(0, over);
      this.dropped += over;
    }
  }
}

/** Durable overflow store for events that could not be sent (offline, 5xx). */
export interface OfflineStore<T> {
  save(items: T[]): Promise<void>;
  /** Return everything stored and clear it. */
  drain(): Promise<T[]>;
}

export const OFFLINE_MAX = 2000;

/** In-memory store: the fallback when IndexedDB is unavailable (private mode, SSR) and the test double. */
export class MemoryStore<T> implements OfflineStore<T> {
  items: T[] = [];
  dropped = 0;
  constructor(private max = OFFLINE_MAX) {}
  async save(items: T[]): Promise<void> {
    this.items.push(...items);
    const over = this.items.length - this.max;
    if (over > 0) {
      this.items.splice(0, over);
      this.dropped += over;
    }
  }
  async drain(): Promise<T[]> {
    return this.items.splice(0);
  }
}

/** IndexedDB store: one record holds the whole bounded array. Falls back to memory when IDB is missing or fails. */
export function idbStore<T>(name = "wt-offline", max = OFFLINE_MAX): OfflineStore<T> {
  const mem = new MemoryStore<T>(max);
  const open = (): Promise<IDBDatabase> =>
    new Promise((res, rej) => {
      const r = indexedDB.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore("q");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  const tx = <R>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<R>): Promise<R> =>
    open().then(
      (db) =>
        new Promise<R>((res, rej) => {
          const t = db.transaction("q", mode);
          const q = fn(t.objectStore("q"));
          t.oncomplete = () => {
            db.close();
            res(q.result);
          };
          t.onerror = t.onabort = () => rej(t.error);
        }),
    );
  const usable = typeof indexedDB !== "undefined";
  return {
    async save(items) {
      if (!usable) return mem.save(items);
      try {
        const old = ((await tx("readonly", (s) => s.get("items"))) as T[] | undefined) ?? [];
        await tx("readwrite", (s) => s.put(old.concat(items).slice(-max), "items"));
      } catch {
        await mem.save(items);
      }
    },
    async drain() {
      const local = await mem.drain();
      if (!usable) return local;
      try {
        const got = ((await tx("readonly", (s) => s.get("items"))) as T[] | undefined) ?? [];
        await tx("readwrite", (s) => s.delete("items"));
        return got.concat(local);
      } catch {
        return local;
      }
    },
  };
}

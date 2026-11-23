import { beforeEach, describe, expect, it } from "vitest";
import { Session } from "./session.js";

beforeEach(() => sessionStorage.clear());

describe("session", () => {
  it("session_rolls_over_after_30m_idle", () => {
    let t = 1_000_000;
    const s = new Session(() => t);
    const a = s.id();
    t += 29 * 60_000;
    expect(s.id()).toBe(a);
    t += 31 * 60_000;
    expect(s.id()).not.toBe(a);
  });

  it("rolls_over_after_4h_even_when_active", () => {
    let t = 0;
    const s = new Session(() => t);
    const a = s.id();
    for (let i = 0; i < 9; i++) {
      t += 29 * 60_000;
      s.id();
    }
    expect(s.id()).not.toBe(a);
  });

  it("sample_decision_stable_per_session", () => {
    const s = new Session();
    const first = s.sampled(0.5);
    for (let i = 0; i < 20; i++) expect(s.sampled(0.5)).toBe(first);
    expect(new Session().sampled(0.5)).toBe(first); // read back from sessionStorage
  });

  it("works_with_blocked_storage", () => {
    const orig = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage")!;
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    try {
      const s = new Session();
      expect(s.id()).toBe(s.id());
    } finally {
      Object.defineProperty(globalThis, "sessionStorage", orig);
    }
  });

  it("persistAnonId_stores_in_localStorage_and_is_off_by_default", () => {
    localStorage.removeItem("wt.anon");
    expect(new Session().anonId()).toBeUndefined();
    expect(localStorage.getItem("wt.anon")).toBeNull();
    const a = new Session(undefined, true).anonId();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Session(undefined, true).anonId()).toBe(a); // survives a new session object
    new Session(undefined, true).clear();
    expect(localStorage.getItem("wt.anon")).toBeNull();
  });

  it("persistAnonId_falls_back_to_memory_when_localStorage_is_blocked", () => {
    const orig = Object.getOwnPropertyDescriptor(globalThis, "localStorage")!;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
    try {
      const s = new Session(undefined, true);
      expect(s.anonId()).toBe(s.anonId());
    } finally {
      Object.defineProperty(globalThis, "localStorage", orig);
    }
  });
});

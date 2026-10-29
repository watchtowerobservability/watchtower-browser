/** The JS Self-Profiling API trace (WICG), only the fields we read. */
export interface ProfilerTrace {
  resources: string[];
  frames: Array<{ name: string; resourceId?: number; line?: number; column?: number }>;
  stacks: Array<{ parentId?: number; frameId: number }>;
  samples: Array<{ timestamp: number; stackId?: number }>;
}

/** Folded text is capped under the edge limit (512 KiB) with headroom. */
export const MAX_FOLDED_BYTES = 480 * 1024;

/** Query and fragment dropped: both can carry tokens. */
const fileOf = (u: string): string => u.replace(/[?#].*$/, "");
/** `;` and whitespace are separators in the folded format. */
const clean = (s: string): string => s.replace(/[;\s]+/g, "_");

/**
 * Convert a trace to folded stacks, root first: `a@f.js:1;b@f.js:2 <samples>`.
 * Frames are `function@file:line`; source maps are resolved server side (debug ids).
 * Idle samples (no stack) are skipped. Heaviest stacks win when the size cap bites.
 */
export function toFolded(t: ProfilerTrace): string {
  const label = t.frames.map((f) => {
    const file = f.resourceId === undefined ? "" : fileOf(t.resources[f.resourceId] ?? "");
    return `${clean(f.name || "(anonymous)")}@${clean(file)}:${f.line ?? 0}`;
  });
  const path = new Map<number, string>();
  const stackOf = (id: number): string => {
    let s = path.get(id);
    if (s === undefined) {
      const st = t.stacks[id];
      if (!st) return "";
      const own = label[st.frameId] ?? "(unknown)@:0";
      s = st.parentId === undefined ? own : `${stackOf(st.parentId)};${own}`;
      path.set(id, s);
    }
    return s;
  };
  const counts = new Map<string, number>();
  for (const s of t.samples) {
    if (s.stackId === undefined) continue;
    const k = stackOf(s.stackId);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let size = 0;
  const lines: string[] = [];
  for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    const line = `${k} ${n}\n`;
    if (size + line.length > MAX_FOLDED_BYTES) break;
    size += line.length;
    lines.push(line);
  }
  return lines.join("");
}

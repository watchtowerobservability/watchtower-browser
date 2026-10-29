import { createHash } from "node:crypto";

/**
 * Debug id algorithm: SHA-256 of the emitted JS bytes, first 16 bytes formatted as a UUID with
 * version nibble 4 and variant 10xx. Same content gives the same id, so rebuilds are stable.
 * Field names: `//# debugId=<uuid>` comment at the end of the JS file, `"debugId"` in the map JSON, and
 * `window._wtDebugIds[<file>] = <uuid>` at runtime so the SDK can send it with error frames.
 */
export function debugIdFor(js: string): string {
  const h = createHash("sha256").update(js).digest();
  h[6] = (h[6]! & 0x0f) | 0x40;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

export function injectDebugId(file: string, js: string, map?: string): { js: string; map?: string; id: string } {
  const id = debugIdFor(js);
  const snippet = `;(function(){try{var w=typeof window!=="undefined"?window:globalThis;(w._wtDebugIds=w._wtDebugIds||{})[${JSON.stringify(file)}]="${id}"}catch(e){}})();`;
  const m = /\n?\/\/# sourceMappingURL=[^\n]*\s*$/.exec(js);
  const body = m ? js.slice(0, m.index) : js;
  const tail = m ? "\n" + m[0].trim() : "";
  return {
    js: `${body}\n${snippet}${tail}\n//# debugId=${id}\n`,
    id,
    map: map === undefined ? undefined : JSON.stringify({ ...JSON.parse(map), debugId: id }),
  };
}

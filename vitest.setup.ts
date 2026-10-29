// happy-dom under vitest exposes some DOM globals as present-but-undefined; rrweb's polyfill then
// reads `.prototype` of undefined. Drop the empty names so rrweb's `"X" in window` guard skips them.
const w = globalThis as Record<string, unknown>;
for (const k of ["NodeList", "DOMTokenList"]) if (k in w && w[k] === undefined) delete w[k];

// rrweb reads text via the untainted `Node.prototype.textContent` getter. In browsers it handles
// text nodes; happy-dom's base getter returns "" for them, so route character data through `.data`.
const desc = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
if (desc?.get) {
  const get = desc.get;
  Object.defineProperty(Node.prototype, "textContent", {
    ...desc,
    get(this: Node) {
      return this.nodeType === 3 || this.nodeType === 4 ? ((this as CharacterData).data ?? "") : get.call(this);
    },
  });
}

# Changelog

## 0.5.7 (2026-11-16)

- Spans the endpoint refuses (HTTP 401, 403 or 404 on `/v1/traces`) now log one console warning per page load naming the URL and status, instead of being dropped silently. The edge now serves `POST /v1/traces` for publishable keys, so the `tunnelHandler` setup delivers spans.

## 0.5.6 (2026-11-15)

- Behaviour change (privacy): with `userActions` on, an action with no `data-wt-action` is named by a text-free selector (tag, id, up to 3 classes, `data-testid`, or `name`), never by the element's text, which could hold names and emails on admin screens. New option `actionNameFromText: true` restores text names (<= 128 chars). `data-wt-action` still wins.
- New `@watchtowerobservability/browser/lite` entry (`dist/lite.js`): `init` and the same API, with no references to the replay, assist, feedback or probes chunks. Use it in single-file builds (Vite inlining dynamic imports) to avoid pulling replay (about 65 KB gzipped); those options are no-ops there.
- `cookieMunchConsent` is exported from the main entry and so is on the `wt.min.js` global (`Watchtower.cookieMunchConsent(client)`); it was only in the ESM `/consent` entry.
- The `/beacon` entry and `consent: "granted" | "pending" | "denied"` shipped in 0.5.5 (see below).
- Browser logs survive failures: a 429 or 5xx retries with backoff (honouring `Retry-After`), a network failure parks the batch in IndexedDB until the next successful send. Other 4xx responses still drop the batch and warn once.
- Opt-in `storage` option: slow or failed IndexedDB, Cache Storage and localStorage operations as `db` events (main-thread work flagged `db.main_thread`), quota and per-store sizes as `storage` events. Lazy chunk; the core bundle does not grow.
- `@watchtowerobservability/browser/storage`: `instrumentSqlJs(db)` and `instrumentWaSqlite(sqlite3)` (operation and table only, never statement text).

## 0.5.5 (2026-11-15)

- Privacy: `revokeConsent()` now aborts in-flight event and log sends, makes the transport and log shipper inert (a send that fails after the revoke is not parked offline, the offline restore is skipped), and deletes the `wt-offline` and `wt-offline-logs` IndexedDB databases with `indexedDB.deleteDatabase` instead of only emptying them (also when consent was still pending). No fetch or `sendBeacon` happens after the revoke, including on `pagehide` / `visibilitychange`.
- `consent: "pending"` now holds up to 100 data calls (`captureError`, `event`, `measure`, `log`, `flag`, `setUser`, `setAttribute`, `setView`) in memory and replays them on `grantConsent()`; `revokeConsent()` drops them. Before, calls made while pending were dropped.
- `urlScrubbing` also takes the presets `"strict"` (= `true`), `"pii"` (adds emails, phone numbers, card numbers, IPv4 in path segments) and `"off"` (= `false`), named like the node SDK's `redact`.
- README documents the `propagateTo` contract (`traceparent`, `baggage` only with a Lucida session, never `tracestate`; the target's `Access-Control-Allow-Headers`).
- New `@watchtowerobservability/browser/beacon` entry (`dist/beacon.js`, `dist/beacon.min.js`, about 1.5 KB gzipped): LCP, CLS, INP (approximated) and up to 10 errors, one `sendBeacon` when the page is hidden. See the README. `init()` returns `{ grantConsent, revokeConsent }` and takes `consent: "granted" | "pending" | "denied"` (default `granted`): unless granted nothing is sent.
- `persistAnonId: true` is now implemented: an anonymous UUID in `localStorage` (`wt.anon`, sent as the `wt.anon_id` attribute), removed by `revokeConsent()`. Default stays off. Declared in the storage declaration.
- The build now empties `dist/` first; older builds left stale hashed chunks (`instrument/tracing-*.js`, `web-vitals.attribution-*.js`) that were published (about 81 KB each).
- `package.json` declares `"license": "Apache-2.0"`.

## 0.5.4

- The build writes `dist/manifest.json`: every `.js` file a self-hoster must serve (path, bytes, sha256, SRI `sha384-` integrity) plus the package version. Generated over the real dist output.
- `dist/storage.json` (and `storageDeclaration` from `src/storage-declaration.ts`): machine-readable list of every client-side storage item the SDK writes. No cookies.
- A lazy chunk that fails to load (404, or HTML served by an SPA fallback) logs one `console.error` naming the chunk and base URL and pointing at `manifest.json`. Public methods still never throw.

## 0.5.3

- URL scrubbing is narrower: only secret-looking path segments are redacted (UUIDs, hex runs >= 16, JWTs, digit runs >= 16, random-looking tokens >= 16 chars mixing letters and digits). Hosts are never touched; readable words, kebab/snake slugs, short ids (`/config/a1b2c3d4`) and file names stay. Behaviour change: 10 to 15 character ids that used to be redacted now show, and 24+ character words without a digit are no longer redacted. Same rule as the node SDK and the gateway; `urlScrubbing.allow` / `.deny` still override.

## 0.5.2

- URL scrubbing no longer redacts readable kebab slugs (lowercase words joined by hyphens, e.g. `/gallery/legal-consultation-intake`); `Xk29dLq0aPz7Xk29dLq0aPz7` is still redacted. New `urlScrubbing: { allow?: RegExp[], deny?: RegExp[] }` (tested per path segment; deny wins, then allow, then the defaults). `false` still turns scrubbing off.
- `init({ lucida })` also takes a getter `() => client | undefined`, resolved each time ids are needed, so the client can load after init.

## 0.5.1

- **Fix: router adapters had no effect in 0.5.0** (`useNextRouteTracking` and the React, Vue, Angular and Svelte adapters). The adapters and the instrumentation ship as separate bundles, each with its own copy of the route state, so the route the adapter set never reached view names; views stayed concrete URLs (`/gallery/contact`). The route now lives on one shared global. Upgrade to get `/gallery/:typeId`.
- Lucida distinct id: `init({ lucida })` / `globalThis.lucida` with `getDistinctId()` now also stamps `lucida.distinct_id` (like `lucida.session_id`; `setAttribute("lucida.distinct_id", id)` wins). Watchtower builds Lucida person links from it.

## 0.5.0

- Event hooks: `client.on("error", cb)` and `client.on("vital", cb)` return an unsubscribe function. `error` gets `{event_id, trace_id?, fingerprint?, message (300 chars), type?, handled, url (no query), ts}` for every captured error (`captureError` is `handled: true`; `window.onerror` and unhandled rejections are `false`); `event_id` is the RUM event `id` ingest stores. `vital` gets `{name, value, rating, navigation_id, url, final}` once per vital per page view, when the page is hidden. Callbacks never throw into the host. Feature-detect with `typeof client.on === "function"` or this version.
- `exposeGlobal: true | "<name>"`: sets `globalThis[name]` (default `watchtower`) and dispatches `watchtower:ready` on window. On by default in the script build (`wt.min.js`), off for npm/ESM.
- Lucida session id: `setAttribute("lucida.session_id", id)` (or `init({ lucida })`) now also stamps error events, logs and spans as `lucida.session_id`, besides the batch attrs, and is sent as W3C baggage `lucida.session_id=<id>` on requests that get a `traceparent` (`propagateTo`).

## 0.4.0

- URL scrubbing is on by default: reported URLs (page, referrer, view/nav/resource/vital `url`, fetch/XHR `http.url`/`url.full`/`url.path`, `url.query` removed) lose query and fragment, and secret-looking path segments (UUIDs, >= 24 chars, >= 10 chars with a letter and a digit) become `:redacted`. Stack-frame script URLs lose only their query. `urlScrubbing: false` opts out.
- Router adapters: with `useNextRouteTracking` (or any adapter) the first page load and client navigations report the route pattern (`/gallery/:typeId`), not the concrete path. Views and navs wait for the adapter's `setRoute` (max 300 ms, or page hide); the first view without an adapter is also delayed by up to 300 ms.
- A relative same-origin `endpoint` (`/api/wt`, a first-party tunnel) works for logs and traces too and is never instrumented as app traffic. README documents the tunnel (`tunnelHandler` in `@watchtowerobservability/node/next`) and a full Next.js CSP.
- `@watchtowerobservability/browser/consent`: `cookieMunchConsent(wt, { rum, replay })`.
- `init({ lucida })`: a client with `getSessionId()`, used before `globalThis.lucida`.
- `grantConsent()` is documented and tested as idempotent.

## 0.3.0

- Lazy chunks load through static imports by default, so webpack 5 / Next 15 build without the "Critical dependency" warning and send events; an explicit `*Url` option or the IIFE build still loads by URL (`webpackIgnore`).
- Types ship (`dist/*.d.ts`, `types` conditions in `exports`); `./package.json` is exported.
- `SDK.version` follows package.json. The "Uncaught " prefix no longer doubles up in error titles.

## 0.1.0

- Initial public release.

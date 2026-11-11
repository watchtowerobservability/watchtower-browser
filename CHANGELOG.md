# Changelog

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

## Unreleased

- Browser logs survive failures: a 429 or 5xx retries with backoff (honouring `Retry-After`), a network failure parks the batch in IndexedDB until the next successful send. Other 4xx responses still drop the batch and warn once.
- Opt-in `storage` option: slow or failed IndexedDB, Cache Storage and localStorage operations as `db` events (main-thread work flagged `db.main_thread`), quota and per-store sizes as `storage` events. Lazy chunk; the core bundle does not grow.
- `@watchtowerobservability/browser/storage`: `instrumentSqlJs(db)` and `instrumentWaSqlite(sqlite3)` (operation and table only, never statement text).

## 0.1.0

- Initial public release.

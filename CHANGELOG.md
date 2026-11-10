# Changelog

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

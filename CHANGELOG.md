# Changelog

## Unreleased

- Opt-in `storage` option: slow or failed IndexedDB, Cache Storage and localStorage operations as `db` events (main-thread work flagged `db.main_thread`), quota and per-store sizes as `storage` events. Lazy chunk; the core bundle does not grow.
- `@watchtowerobservability/browser/storage`: `instrumentSqlJs(db)` and `instrumentWaSqlite(sqlite3)` (operation and table only, never statement text).

## 0.1.0

- Initial public release.

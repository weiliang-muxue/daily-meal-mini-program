# Released AI protocol

The JavaScript files here are this project's unchanged 0.2.1 AI runtime, pinned to the source commit and LF-normalized hashes in `source-manifest.json`. No credentials, local configuration, runtime records, packages, or external project code are copied. The root function's existing SDK dependency and environment variables are used.

Only requests that omit `clientContractVersion` select this original contract-2 / planner-7 / task-3 handler. Current clients explicitly send contract 4. Explicit unsupported versions never fall back. Each handler still validates WeChat identity, member status, namespace, consent, provider revision, task ownership and write revisions. A client version is not authorization.

Current workers must not claim, cancel or turn a still-running released task into a failure. The state migration waits for a bound active task to finish or expire. A released writer refuses a user document above schema 8, and a current writer requires migrated state before starting/finalizing. Finished old task records are retained; current-task lookup may clear only their stale control pointer.

Deploy this bridge before enabling schema-13 user-state migration. Keep the same reviewed provider configuration; do not copy or print environment values. Local synthetic tests are not cloud or phone acceptance. The legacy branch can be removed only after the released clients/tasks no longer need it; any security backport requires an explicit new pin and review.

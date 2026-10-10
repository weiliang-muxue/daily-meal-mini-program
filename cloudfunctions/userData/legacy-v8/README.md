# Released client compatibility boundary

These four JavaScript files are this project's unchanged `userData` implementation from the published 0.2.1 source commit named in `source-manifest.json`. They are not a separate cloud function, database, or third-party dependency. LF-normalized SHA-256 checks prevent shared-schema synchronization from silently replacing them.

The parent entry point delegates only the five original actions when the request **omits** `clientSchemaVersion`. Explicit invalid versions and new-only actions do not fall back. The original handler still derives identity from WeChat and checks membership, cache namespace and state revision inside transactions.

Old requests keep schema-v8 users on schema v8. A current client can incrementally migrate its own state. Once a stored document has a higher schema, this frozen handler rejects it before any write; the parent returns an update-required message. It does not project or downgrade newer data to schema v8, and cannot keep an old device writable after that user's upgrade.

This is only the user-state part of the rollout. Do not deploy it independently to production before the AI protocol/worker compatibility and real cloud acceptance are completed. Do not remove it until released old clients no longer need it. Security fixes, if needed, require an explicit reviewed source revision and regenerated pin, not silently editing the frozen files.

# FELTUS destructive lifecycle contract

**Status:** repository contract for the implemented deletion paths. This document describes code and migration behavior; it is not evidence that Production or a shared Staging database has been changed.

This is the authoritative lifecycle reference for deleting fields, relationships, models, and applications. Older phase documents may describe a narrower feature boundary. Their historical scope is retained, with supersession called out where it is out of date.

## Lifecycle operations

### Field deletion

The Data setup flow offers impact review and an explicit confirmation before removing an eligible custom field. The API verifies ownership and the exact registered model/table/column identity before dropping the column and updating model-column metadata and canonical application state. The field's values in that column are removed. System fields and unsafe/unregistered mappings are protected. The deletion does not rewrite an existing immutable Blueprint.

### Relationship deletion

The relationship flow previews impact and requires confirmation. The API checks the exact registered, same-application foreign-key constraint before dropping it and removing its registry row. Removing the constraint does not delete rows from either model. A relationship change is performed as removal followed by creation; there is no in-place update operation.

### Model deletion

The owner reviews impact and confirms removal. The server verifies the app/model registry and exact physical table name, then removes that model's registered relationships, physical table (including its rows), and model metadata. It does not use cascading table deletion. The affected application state is reconstructed and tracked under the existing state/hash rules; prior Blueprint records remain immutable.

### Application archive and permanent deletion

Archive is reversible: `active -> archived -> active`. Archived app data remains present and readable under the existing read permissions. Writes are closed while archived. Archive does not queue cleanup.

Permanent deletion is asynchronous and owner-only. The owner must provide the exact application name after reviewing the deletion impact. The database records the impact snapshot and request ID, closes normal app access, cancels queued app work, detaches or suspends app links, and queues `application.cleanup`. Repeating the request is idempotent; failed or blocked cleanup can be retried with the same request identity.

The lifecycle states are:

| State | Meaning and next allowed action |
| --- | --- |
| `active` | Normal app access. Can be archived or submitted for deletion. |
| `archived` | Reversible read-only app state. Can be restored or submitted for deletion. |
| `requested` | Deletion request and impact snapshot recorded. Internal transition. |
| `validated` | Impact gates passed. Internal transition. |
| `tombstoned` | Normal app access is closed and queued work is cancelled. Internal transition before cleanup is queued. |
| `cleanup_pending` | Durable cleanup job is queued or eligible for retry. |
| `cleanup_in_progress` | Service worker owns cleanup; local-file removal is recorded before database cleanup. |
| `cleanup_failed` | Cleanup failed without automatic retry; owner may request a retry. |
| `cleanup_blocked` | Cleanup is blocked by a condition that requires resolution; owner may request a retry after resolution. |
| `cleanup_complete` | App data cleanup is complete. The application tombstone remains. |

Retries return `cleanup_failed` or `cleanup_blocked` to `cleanup_pending`, increment the retry count, and preserve the original request ID. Cleanup stages are guarded by that request ID and are safe to repeat.

## Deletion and retention matrix

| Operation | Removed | Retained or changed |
| --- | --- | --- |
| Custom field | Physical column and its values; column registry entry | Other columns and rows; prior Blueprints |
| Relationship | Exact foreign-key constraint and relationship registry entry | Model rows; prior Blueprints |
| Model | Exact physical table and its rows; model and relationship registry entries | Other models; prior Blueprints and audit history |
| Archive | Nothing | App data, models, documents, Blueprints and history remain; access becomes read-only until restored |
| Application cleanup | App model tables/rows and model metadata; relationship metadata; documents and extraction/knowledge data; AI conversations/messages; CODE session/action/checkpoint records; project/environment secret records; tool/usage records; app assets; project memberships; non-cleanup jobs; local app document and CODE workspace directories | Application row as `cleanup_complete` tombstone; lifecycle request/snapshot and cleanup job history; Blueprints; builds, artifacts, deployments, observed state, state deltas, audit and activity history; repository, target, domain and environment records |
| Application cleanup side effects | Pending app deployment outbox work is cancelled; active deployment targets are disabled; active environments are suspended; project repository links are detached | Git/hosting/registry/domain/provider resources are not deleted. Their provider references and database history are retained. |

Impact preview reports counts and the external-resource boundary before permanent deletion. Local filesystem cleanup validates the application UUID and storage root and removes only the app-ID directory; it does not follow symlinks outside the app directory or remove sibling app directories.

## Access, worker, and immutability rules

- Lifecycle RPCs require an authenticated owner; the internal cleanup RPCs require `service_role`.
- Normal access is denied for tombstoned and cleanup states. Normal writes are blocked once lifecycle deletion begins.
- Owner-membership deletion remains protected during ordinary operations. A narrowly scoped exception allows the service-role cleanup transaction to remove that membership only while the same application is `cleanup_in_progress` and the internal lifecycle setting is active.
- The job claimant accepts `application.cleanup` jobs for tombstoned apps so cleanup can finish. Queued ordinary jobs, queued builds, and pending provider outbox commands are cancelled at tombstoning; running ordinary jobs receive a cancellation request. Build and provider claimers also require an active application.
- Canonical application state, state hashes, observed state, deltas, and existing Blueprint rows retain their established immutable-history rules. Lifecycle cleanup preserves Blueprint and audit records; it does not regenerate or rewrite them.
- No RLS policy is disabled or weakened by the application lifecycle migration. External provider APIs are not called to destroy hosted resources.

## Implementation references

- Field and relationship deletion: `20261107020000_feltus_safe_schema_deletion.sql`.
- Model deletion: `20261107030000_feltus_safe_model_deletion.sql`.
- Application archive, tombstone, cleanup guards, and worker claim rules: `20261108010000_feltus_application_lifecycle.sql`.
- Narrow authorization exception for cancelling a queued build during an active deletion request: `20261108020000_feltus_allow_lifecycle_build_cancellation.sql`.
- Wizard routes and application cleanup worker: `src/lib/feltus-app-wizard.js`, `src/lib/feltus-application-cleanup-worker.js`, `src/lib/feltus-application-filesystem-cleanup.js`, `src/worker.js`, and `src/server.js`.
- Consolidated local regression checkpoint: `npm run test:destructive-lifecycle`.
- Rollback-only database regression: `scripts/application-lifecycle-postgres-tests.sql`.
- The consolidated runner executes database checks only when their container name, Postgres image, no-mount state, `--network none`, and absence of published ports pass its disposable-container check. Database names/users can be supplied with `FELTUS_PHASED_TEST_DB_CONTAINER`, `FELTUS_CP_TEST_DB_CONTAINER`, `FELTUS_CP_TEST_DB_NAME`, and `FELTUS_CP_TEST_DB_USER`.

Database runtime validation must use a disposable, isolated Postgres/Supabase-compatible database and synthetic fixtures. It does not authorize applying migrations or tests to Production or shared Staging. A local code/test pass does not establish deployment readiness or external-provider deletion.

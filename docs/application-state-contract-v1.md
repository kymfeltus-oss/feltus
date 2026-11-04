# FELTUS Application State Contract v1

**Contract identifier:** `feltus.application-state/v1`

This contract describes an application independently from PostgreSQL. PostgreSQL persists records that implement it; database table shapes do not redefine the product contract. Contract changes require an explicit new contract identifier and a migration path.

## Canonical JSON shape

```json
{
  "contract": "feltus.application-state/v1",
  "application": {
    "id": "<stable application ID>",
    "name": "<application name>",
    "type": "<application type>",
    "lifecycle_status": "draft | configuring | active | archived"
  },
  "blueprint": {
    "id": "<blueprint ID or null while drafting>",
    "version": "<positive integer or null while drafting>",
    "parent_id": "<parent blueprint ID or null>",
    "parent_version": "<positive integer or null>",
    "status": "draft | ready | building | deployed | superseded | archived",
    "created_by": "<actor ID or null>",
    "created_at": "<ISO 8601 UTC timestamp or null>",
    "state_hash": "<64 lowercase hexadecimal SHA-256 characters or null while drafting>",
    "source_commit": "<Git commit SHA or null>"
  },
  "desired_state": {
    "data": { "models": [], "relationships": [] },
    "knowledge": { "documents": [] },
    "ai": {},
    "code": {},
    "environments": []
  },
  "execution": {
    "builds": [],
    "artifacts": [],
    "deployments": []
  },
  "observed_state": null
}
```

### Required and optional values

- `contract`, `application.id`, `application.name`, `application.type`, and `application.lifecycle_status` are required non-empty strings.
- `desired_state` is required. `data.models`, `data.relationships`, `knowledge.documents`, `environments`, and the three `execution` collections default to empty arrays.
- Blueprint metadata is nullable only for an unsaved draft. A persisted blueprint requires an ID, version, state hash, creator, and creation timestamp. The first version has no parent; each later version names the immediately preceding version and ID.
- Records use stable IDs when FELTUS has one. Git commits use their full source SHA. Artifact identity uses a content digest. Missing external facts use `null`; they are not guessed.
- Secret values are never part of canonical state. Secret references and non-sensitive fingerprints may be represented when their semantics are documented.
- Each domain section may add documented fields within v1. A field must not silently change meaning. Breaking meaning or normalization changes require a new contract version.

## Domain semantics

- **Application** identifies the app and its user-visible lifecycle.
- **Desired state** is the saved application intent: data models and fields, relationships and delete behavior, document metadata and eligibility, AI purpose/settings and source permissions, repository/branch/commit references, and environment target configuration. It contains no document contents, database row values, credentials, or runtime observations.
- **Execution** records build, artifact, and deployment references as facts. It is lineage evidence and is not part of blueprint identity.
- **Observed state** records what a provider reports for a deployment, including environment, provider/deployment ID, blueprint version, source commit, artifact digest, health, observation time, and a hash of the observation. It never overwrites desired state.
- **Delta** is a factual comparison with one of `changed`, `added`, `removed`, or `unknown`. It records values and references; Phase 3 does not assign compliance, risk, readiness, or policy judgments.

## Ordering, normalization, and state identity

- All strings are Unicode NFC normalized. JSON values only are accepted. Object keys are recursively ordered lexicographically for canonical JSON. Sensitive-value keys (credentials, secrets, passwords, private keys, API keys, access/refresh tokens) are omitted; `max_tokens` is a generation setting and is retained.
- Models sort by stable ID (then name when no ID is present). Fields sort by `ordinal_position`, then field name; this order is explicit schema display order. Relationships sort by stable ID, or by source model/field and target model/field when no ID exists. Documents and execution references sort by stable ID. Environments have the fixed order Development, Preview, Staging, Production. Observation histories sort by timestamp, then stable ID. These orderings make input/database query order irrelevant.
- Blueprint identity is SHA-256 over canonical UTF-8 JSON containing exactly `contract`, application identity (`id`, `name`, `type`, `lifecycle_status`), and `desired_state`. Blueprint IDs, versions, parent references, creation metadata, execution records, event records, and observed state are excluded. Thus deployment activity cannot silently change the desired blueprint hash.
- State changes that alter any included application identity or desired-state value create a new blueprint version. Saving an unchanged CURRENT state reuses the current revision. Returning to an older historical state creates a new chronological revision whose semantic hash may match an older revision. SHA-256 output is 64 lowercase hexadecimal characters.

## Blueprint lineage and immutability

- The first revision is version 1 with no parent. Each child is exactly parent version + 1 and carries both `parent_id` and `parent_version`.
- `id`, application, version, parent, creator, creation timestamp, source commit, state hash, desired state, and execution lineage are immutable after insertion. Only the lifecycle status may transition; historical content is never rewritten.
- A build captures one blueprint ID/version and one full commit SHA. An artifact is immutable and references the build, blueprint, commit, image/reference, and digest. A deployment references the same artifact and blueprint/commit lineage. Promotion reuses the artifact digest; rollback creates a new deployment record that refers to the prior deployment/artifact.

## YAML serialization

`application.feltus.yaml` is a deterministic, human-readable YAML block document generated from the normalized canonical state object. It is a portable view only and cannot write back to FELTUS state in Phase 3. YAML formatting never contributes to `state_hash`; the hash uses canonical JSON derived from semantic state.

## Persistence mapping

The relational model should preserve rather than define this contract:

- `feltus_application_blueprints`: immutable per-app revisions; primary key `id`; unique `(app_id, version)`; non-unique `(app_id, state_hash)` lookup index; self-reference to parent; index by app/version descending. Repeated hashes are allowed when an app returns to an older state.
- `feltus_builds`: commit and source repository plus blueprint foreign key.
- `feltus_artifacts`: unique per-app immutable digest and composite foreign keys to build and blueprint.
- Existing environments, deployment targets, deployments, and promotion records remain the deployment control plane; deployment rows link to blueprint and artifact.
- `feltus_observed_application_states`: append-only provider observations linked to environment, deployment, blueprint, and artifact; indexed by app/environment/time.
- `feltus_application_state_deltas`: structured comparison records linked to the observed state and blueprint; indexed by app/time.
- `feltus_audit_events`: existing immutable audit records extended with typed Blueprint/commit/build/artifact/deployment lineage, event category/severity, friendly summary, and safe metadata; indexed by app/time and lineage references. Existing deployment-specific details remain in `feltus_deployment_events`.

All app-scoped relationships use composite foreign keys that include the app and organization identifiers. Read policies remain app scoped. Application state writes go through validated server routes or narrow database functions; the browser cannot directly rewrite canonical snapshots.

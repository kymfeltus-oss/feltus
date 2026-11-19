# Phase H — Day-2 Reconciliation

Phase H adds a source-bound, evidence-only reconciliation layer to the existing FELTUS application lifecycle. It answers whether persisted desired state and persisted observed state are consistent at one exact cutoff; it does not create a second deployment, source-control, Design Studio, or activity system.

## Contract and persistence

The evaluator contract is `feltus.day2-reconciliation/v1` in `src/lib/feltus-day2-reconciliation.js`. Each run freezes a manifest containing the organization, application, environment and optional deployment scope; desired Blueprint identity; source workspace/branch/checkpoint/snapshot/classifier identity; environment target; Design State hash; observation cutoff; policy/evaluator versions; actor; correlation ID; and idempotency key.

The manifest has a deterministic hash and run ID. A retry of the same manifest reuses the evaluation. A changed Blueprint, target, source identity, Design State binding, or observation binding creates a new run. Historical results are resolved against current bindings; a mismatch becomes `STALE` and is never silently presented as current.

No Phase H migration or RLS change is required. The existing `feltus_code_actions` stream stores append-only envelopes:

- `state.reconciliation.day2_started`
- `state.reconciliation.day2_evaluated`
- `state.reconciliation.day2_duplicate`
- `state.reconciliation.day2_superseded`
- `state.reconciliation.day2_failed`

These records contain the manifest, snapshot identities, drift fingerprints, precondition hashes, action status, actor/correlation information, and safe evidence only. They do not contain secret values.

## Routes

- `POST /api/apps/:appId/state/reconciliation/evaluate` records a scoped evaluation. It requires an environment, valid cutoff/freshness window, and the existing `canRunAgent` capability.
- `GET /api/apps/:appId/state/reconciliation?environment=<kind>&as_of=<ISO-8601>` returns the latest scoped evaluation overlaid with current binding checks.

The routes reuse the existing application-state loader, immutable Blueprint history, observed-state/delta records, CODE checkpoints, source classification context, Design Studio source reconciliation, and CODE activity stream. They do not call a provider or a deployment RPC.

## Drift policy

The evaluator emits stable, order-independent fingerprints for scope, desired-state, Blueprint lineage, source/checkpoint, artifact, environment, deployment-state, runtime-health, schema/configuration, Design Studio, and temporal evidence differences.

- `SAFE_AUTOMATIC` is limited to a future request through an already verified worker/outbox boundary, or a deterministic component-scoped Design Studio action. The Phase H evaluator records the candidate but never executes it.
- `REVIEW_REQUIRED` preserves the exact source, Blueprint, artifact, target, component, and precondition evidence for an existing explicit lifecycle action.
- `BLOCKED` stops reconciliation for ambiguous/cross-scope/stale/malformed evidence, dirty or checkpointless source, protected-contract changes, unverified artifact lineage, uncertain health, or unsafe rollback conditions.

The overall result is `CURRENT`, `REVIEW_REQUIRED`, `BLOCKED`, or `STALE`. `CURRENT` means the selected persisted evidence is internally consistent at the cutoff only; it is not a provider, runtime, build, or deployment claim.

## Design Studio and source safety

Phase H consumes the verified F.5 component model as component-scoped evidence. A synchronized `DEVELOPER_MANAGED` component is preserved and does not itself block reconciliation. Required reconciliation remains review-required, while component conflicts, managed-stylesheet conflicts, and source-binding mismatches remain blocking. Evidence includes exact component IDs and repository-relative source paths.

The current CODE source must bind to the application, workspace, branch, full checkpoint/commit, complete snapshot hash, and classifier version. Dirty, stale, missing, or ambiguous source state blocks any repair proposal. A source change remains an explicit CODE change-set/checkpoint workflow.

## Build and deployment boundary

Phase H does not grant build eligibility, create a build, create an artifact, deploy, promote, roll back, mutate a Blueprint, write source, call a provider, or access Production/shared Staging. Existing explicit build/deployment/rollback actions remain separate and retain their Phase G gates. A queued command is not treated as a successful reconciliation; a fresh persisted observation and scoped health evidence are required before a drift can close.

## Known limitations

- The evaluator consumes only persisted observed state and local source/design evidence. It does not perform live provider collection.
- Applications with data models or required runtime configuration remain blocked until a scoped schema/configuration evidence adapter records those facts; Phase H never infers parity from health alone.
- Safe automatic candidates are recorded but not executed in Phase H.5+ work would need explicit authorization before extending any worker/outbox behavior.

# Application State API v1

These authenticated app-scoped routes return the `feltus.application-state/v1` contract or references to its immutable execution records. Every route authorizes the app owner before reading or changing state.

| Route | Method | Contract |
| --- | --- | --- |
| `/api/apps/:appId/state` | `GET` | Canonical current graph, current state hash, deterministic YAML preview, feature availability, latest Blueprint metadata, a fresh desired/observed comparison, and persisted delta records linked to the latest observation. |
| `/api/apps/:appId/blueprints` | `GET`, `POST` | Blueprint history or save current state. An unchanged current hash reuses the latest revision; returning to an older hash creates a new version. |
| `/api/apps/:appId/blueprints/:blueprintId/export` | `GET` | Deterministic human-readable `application.feltus.yaml` download for that immutable revision. |
| `/api/apps/:appId/environments` | `GET` | Development, Preview, Staging, Production state, target metadata, latest/available artifact, deployment status, and observation health. Secret values are excluded. |
| `/api/apps/:appId/environments/target` | `POST` | Configure an environment target when provider configuration and production gates allow it. |
| `/api/apps/:appId/events` | `GET` | App activity from the existing immutable `feltus_audit_events` stream, filtered to structured Phase 3 records. Deployment transitions continue to use `feltus_deployment_events`. |
| `/api/apps/:appId/builds` | `GET`, `POST` | Build history or a build request pinned to the current saved Blueprint, connected repository, branch, and full commit SHA. Queueing requires a fresh online `build` worker heartbeat as well as the isolated runner and artifact registry configuration. |
| `/api/apps/:appId/builds/:buildId/cancel` | `POST` | Cancel a queued or running build through the narrow database function. |
| `/api/apps/:appId/deployments` | `GET`, `POST` | Deployment history or deployment of a verified immutable artifact. Preview execution remains unavailable until isolated preview provisioning is configured. |
| `/api/apps/:appId/deployments/promote` | `POST` | Promote a healthy Staging deployment using the same verified artifact, subject to the Production feature gate and target checks. |
| `/api/apps/:appId/deployments/:deploymentId/rollback` | `POST` | Record a rollback to a prior healthy artifact with a reason; history is preserved and Production remains gated. |
| `/api/apps/:appId/github` | `GET` | Report server configuration, the connected GitHub account, and repository/webhook status without returning credentials. |
| `/api/apps/:appId/github/connect` | `GET` | Begin a user-bound GitHub OAuth flow when credentials and a valid FELTUS public URL are configured. |
| `/api/github/callback` | `GET` | Validate the signed state and browser nonce, exchange the OAuth code, and persist an encrypted server-side connection. |
| `/api/apps/:appId/github/repositories` | `GET` | List repositories available to the connected GitHub account and app-linked repository records. |
| `/api/apps/:appId/github/repository` | `POST` | Attach a selected repository, persist its default branch and current commit, and attempt webhook setup. |
| `/api/apps/:appId/github/webhook` | `POST` | Retry webhook setup for the app's attached repository. |
| `/api/github/webhooks/:repositoryId` | `POST` | Verify GitHub's HMAC signature and persist a deduplicated, structured push or pull-request event and branch commit. |

Build execution, provider deployment execution, and readiness scoring are not implemented by these routes. GitHub OAuth and webhook processing remain unavailable until their credentials, encryption key, and public URL are configured. No Git event automatically deploys an app. The build API fails closed even if registry flags are present without a live build worker.

## Phase 3 operational status

Phase 3 is **not ready**. The Application State contract, Blueprint API, structured events, observed-state reconciliation, and GitHub source routes are implemented. The current runtime has no GitHub OAuth configuration, dedicated build worker, artifact registry credentials, or Coolify provider configuration. A real build-to-Staging-to-observation journey has not been run. The local Supabase database has not received this migration; only the isolated PostgreSQL validation database has.

The Coolify reconciler records provider deployment status, runtime health, immutable artifact digest, source commit, Blueprint reference, and observation time through `feltus_record_observed_application_state`. It stores factual Blueprint/artifact/health deltas through `feltus_record_application_state_deltas`; stable observations are idempotent. The API exposes the latest persisted delta records separately from its live comparison of current desired state to the latest observation.

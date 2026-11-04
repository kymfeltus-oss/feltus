# Phase 3 schema reuse audit

Phase 3 extends FELTUS's existing sources of truth. PostgreSQL table layouts persist the application-state contract; they do not define its meaning.

## Reused and extended

| Existing source | Phase 3 use |
| --- | --- |
| feltus_applications and setup_data | App identity, wizard status, description, intent details, and AI settings remain on the existing app row. The wizard uses the existing draft/resume fields. |
| feltus_models, feltus_model_columns, feltus_model_relationships | Data categories, fields, and relationships are read from the live model APIs and represented in canonical desired state. |
| feltus_documents | Knowledge metadata and processing status are captured. Document contents are excluded. |
| feltus_environments, feltus_deployment_targets, feltus_deployments, feltus_deployment_promotions | Existing environments and deployment control plane remain authoritative. Phase 3 adds Blueprint/artifact lineage, environment eligibility, idempotent queue APIs, and state observations. |
| feltus_git_connections, feltus_repositories, feltus_project_repositories, feltus_repository_branches, feltus_git_webhook_events | Existing Git account, repository, branch, and verified webhook records are reused. The migration only adds fields needed for safe linkage and protected secret metadata. |
| feltus_builds, feltus_build_steps, feltus_artifacts | Existing build and artifact entities are extended with immutable Blueprint lineage, digest checks, idempotency, environment eligibility, and runner lease metadata. No second build or artifact store is created. |
| feltus_audit_events, feltus_deployment_events, feltus_activity_log | Existing immutable audit and activity streams remain. feltus_audit_events gains typed app-state lineage and friendly event fields; deployment-specific status transitions remain in feltus_deployment_events. No parallel application event table is introduced. |

## New state-contract entities

- feltus_application_blueprints stores chronological immutable contract revisions. It has a unique per-app version and a non-unique state-hash lookup index so a historical semantic state can recur at a new version.
- feltus_observed_application_states stores provider observations tied to deployment, Blueprint, artifact, commit, and environment.
- feltus_application_state_deltas stores factual desired-versus-observed differences. It does not assign readiness, compliance, or risk judgments.

These structures were absent from the existing schema and hold contract concepts that should not be packed into generic app settings or deployment status text.

## Migration status and configuration

The migration has been applied successfully in a disposable PostgreSQL 17 database. It has not been applied to the persistent local Supabase database, staging, or production.

The GitHub OAuth and webhook code is implemented, but its required URL, OAuth credentials, and encryption key are absent from the current runtime configuration. The separate isolated BuildKit worker, pinned checkout, bounded/redacted build logs, cancellation/timeout handling, exit-code persistence, and registry digest verification are implemented. It remains offline until its BuildKit mTLS endpoint, registry credentials, and GitHub credential decryption key are supplied. Coolify/Staging URL, token, and resource mapping are also absent, so no provider deployment can be run. Production execution remains explicitly gated.

# FELTUS Deployment Control Plane Database v1

This phase adds the PostgreSQL data model and database access boundaries for the deployment control plane. It uses FELTUS's existing self-hosted Postgres/Supabase-compatible stack; it adds no paid service, runtime, or container.

Migration: `supabase/migrations/20261102020000_feltus_deployment_control_plane.sql`

## Existing records reused

- `feltus_applications` remains the project table. The migration assigns each existing owner a personal organization and adds the required `organization_id`.
- `feltus_project_memberships` remains the project-member table. Its existing role is linked to the normalized RBAC catalog and its project organization is constrained by a composite foreign key.
- `feltus_deployments` remains the deployment record. Legacy entries are backfilled to a project environment and remain readable.

New projects receive a personal organization when no organization is supplied, plus development, staging, and production environments. Organizations created by an authenticated user are created with `rpc/feltus_create_organization` and an owner membership.

## Added schema

- Organization membership and a seeded v1 role/permission catalog.
- Project environments and preview metadata with expiry and resource limits.
- Git connections, repository/branch bindings, and deduplicated webhook receipts.
- Explicit project-to-repository bindings so a build cannot reference another project's repository, even inside the same organization.
- Build records and steps, plus OCI artifacts identified by immutable `sha256` digest.
- Deployment targets, deployment events, health checks, domains/TLS state, and artifact promotions.
- Environment-scoped encrypted secret storage and a metadata-only view for authenticated users.
- Append-only audit records for membership, environment, secret, build, artifact, target, domain, promotion, and deployment changes.
- `feltus_infrastructure_outbox` with a `SKIP LOCKED` claim function, lease token/version, heartbeat, retry, and completion functions.

## Database invariants

- Composite foreign keys tie memberships, environments, builds, artifacts, deployments, and outbox commands to the same organization and project.
- Project access checks require an active organization membership and a role permission or an existing explicit project permission.
- Organization owners/admins can access organization projects according to the seeded permission map; ordinary organization members need explicit project membership.
- Only a successful build can produce an artifact marked verified. Once verified, an artifact's repository image and digest cannot be changed in place.
- Builds can reference only a repository bound to the same project; webhook-triggered builds require a signature-verified, accepted event whose commit and branch match the build request.
- An artifact-backed deployment requires a verified artifact, an authorized actor, an active provider target, and an idempotency key.
- An `AFTER INSERT` trigger writes the outbox command in the same transaction as an artifact-backed deployment. A rollback therefore removes both records.
- Promotion requires a healthy source deployment and uses that deployment's exact verified artifact for the target environment.
- Outbox rows cannot be read or mutated directly by browser roles or `service_role`; the worker gets access through narrow `SECURITY DEFINER` functions. Claiming uses row locks with `SKIP LOCKED`, leases, and fencing tokens.
- Outbox payloads contain artifact/target identifiers and digest only. A recursive constraint rejects secret-like JSON property names.
- Authenticated users can read only authorized metadata. They cannot select ciphertext or mutate infrastructure/deployment records directly.

## Secret handling

Secret and Git credential columns store ciphertext and a key-version label. PostgreSQL does not encrypt these values automatically. The application must encrypt before insert and decrypt only inside trusted server/worker code using a key supplied outside the database. The migration does not add a key-management service or expose plaintext through PostgREST.

Preview secrets use `feltus_environment_secrets` scoped to the preview environment. There is no database inheritance or copy operation from production.

## Outbox worker contract

Use these RPCs as the worker state machine:

1. `feltus_claim_infrastructure_outbox(worker_id, limit, lease_seconds)` claims due rows and returns a lease token/version.
2. Re-read the artifact and target immediately before dispatch; stop if the artifact was revoked or the target disabled after claim. Call the provider outside a database transaction. Reconcile the provider before retrying after an uncertain network outcome.
3. `feltus_heartbeat_infrastructure_outbox(id, lease_token, lease_seconds)` extends a live lease for long operations.
4. `feltus_complete_infrastructure_outbox(id, lease_token, provider_operation_id)` records provider acceptance and moves the deployment to `DEPLOYING`.
5. `feltus_retry_infrastructure_outbox(id, lease_token, safe_error_code, retryable)` schedules bounded exponential retries or dead-letters the command.

Coolify API credentials stay in trusted runtime configuration, not in targets or outbox payloads. Deployment targets store only the Coolify resource references. Builds are represented independently and do not run through the Coolify deployment adapter.

## Scope and rollout state

This migration establishes schema and RLS only. It does not implement the Git webhook endpoint, build runner, artifact publisher, Coolify adapter, domain provisioning, secret-encryption code, or deployment worker. The existing deployment-history route creates record-only rows when no artifact is supplied; only artifact-backed rows enter the new outbox.

The migration is picked up by the existing `migrate` Compose service on the next stack startup. It has not been applied to staging or a clean database in this change. Staging migration and isolation checks remain required before any deployment worker is enabled.

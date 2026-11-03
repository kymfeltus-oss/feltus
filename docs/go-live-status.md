# FELTUS go-live status

Status for the production recovery work as of 2026-11-03. Local code checks do not verify a public deployment. FELTUS remains a **production candidate**, not a production-ready service, until the blocked staging and production gates below are completed.

## Recovery update — 2026-11-03

- Reproduced the reported pending-trigger index failure in a disposable copy of the existing schema. The migration's deferred organization-membership role foreign key had queued events when PostgreSQL reached the membership indexes and later RLS DDL. The repair validates that specific constraint immediately; it does not disable or bypass it.
- The migration runner wraps each SQL migration and ledger insert in one transaction. The reproduced failed run left the control-plane ledger row absent. This proves the runner's rollback behavior on the disposable database; the production ledger itself remains unavailable for direct inspection.
- The corrected migration sequence passed on disposable existing-project and fresh databases. The named deferred-constraint flush passed with a real membership insert and index creation inside a rolled-back transaction. A forward-only digest repair then applied over an already-recorded 16-migration database; its ledger recorded the 17th migration. Existing fixture application and membership records remained present. The deployment-control-plane PostgreSQL integration suite passed after its test database was given the required active target fixture.
- The same test image places `pgcrypto.digest` in `extensions`; the deployment trigger previously called `public.digest`, which would fail when an artifact-backed deployment was inserted. The function now resolves `digest` through `extensions` first and `public` second.
- A private infrastructure-outbox consumer and server-side Coolify v1 client were added. Local tests cover lease RPCs, scope/artifact checks, exact environment-to-resource mapping, digest pinning, production gating, server-only credentials, HTTPS enforcement, and redirect refusal. This is code-level verification only; no Coolify API or real deployment was contacted.
- `npm run check`, `npm run test:core`, `npm run test:code`, `npm run test:infrastructure-worker`, `npm run regression`, and the disposable-database `npm run test:deployment-control-plane` passed. Compose configuration parsing and local image builds for `app`, `worker`, and `evidence-extractor` passed.

## Still blocked

- No Coolify URL/token or verified isolated staging database/stack is available from this checkout. The actual staging migration, acceptance script, container health, outbox-to-Coolify deployment, domain/TLS verification, and reconciliation have not been run.
- `FELTUS_COOLIFY_ALLOWED_ENVIRONMENTS` and `FELTUS_COOLIFY_RESOURCE_MAP` default empty, so infrastructure outbox processing remains disabled until isolated environment mappings and token permissions are verified. Production dispatch additionally requires the production allowlist entry and `FELTUS_COOLIFY_PRODUCTION_ENABLED=true`.
- No production backup, migration-ledger inspection, Coolify deployment, or owner approval has occurred. The code is committed locally on `codex/feltus-production-recovery` and has not been pushed.
- Public domain health could not be independently checked from this environment; HTTPS requests to the two public domains were unreachable here. The owner-reported 503 condition has not been cleared or rechecked from an external network.

## PASS

- AI trust policy is implemented for `local_private`, `private_managed`, `external_trusted`, and `external_unverified`; stored history remains off by default.
- AI endpoint validation rejects unapproved private destinations and unlisted trusted external hosts; AI HTTP clients block redirects.
- Server-side conversation history loading requires the authenticated owner, project, active conversation, and scoped message rows; the configured window is capped at 20 messages.
- `npm run check` passed, including syntax checks for all AI trust/history/prompt modules.
- `npm run regression` passed, including trusted-local and unverified-external policy checks, cross-project/owner history filtering, prompt exclusion, AI redirect blocking, and stale-stream cancellation on project switching.
- PDF extractor `python -m unittest discover -s tests -v` passed (2 tests).
- `docker compose --env-file .env.example --file compose.production.yaml config --quiet` passed.
- `.github/workflows/production-regression.yml` parsed successfully with PyYAML.
- Production Docker Compose, RLS policies, backup/restore scripts, CI workflow, and deployment documentation are present in the branch. These artifacts are not evidence that production infrastructure has been exercised.
- The core platform is implemented as an additive migration: project membership/profile tables, multi-conversation chat controls, provider-neutral local AI adapters, embeddings, knowledge-base records, durable jobs, a private worker, safe tools, encrypted secret metadata, usage records, deployment records, realtime publication, and project-scoped RLS policies are present.
- `npm run check`, `npm run test:core`, and `npm run regression` passed after the core-platform implementation. The regression includes production startup gates for service-role and secret-encryption configuration, provider adapter behavior, worker leasing/cancellation/retry controls, first-class chat controls, and Compose validation.
- FELTUS CODE is integrated on `codex/feltus-code-integration`; its per-project filesystem root is server-derived, project access uses the authenticated PostgREST/RLS context, `.git` metadata/secrets/symlinks/traversal are blocked, writes use SHA-256 conflict checks, and task execution is limited to repository-defined FELTUS checks.
- `npm run test:code` passed for safe file create/read/write/rename/delete, secret redaction, search/repo map, symlink and traversal denial, exact Git-root validation, parent-repository inheritance denial, explicit checkpoint confirmation, allowlisted tasks, arbitrary-command rejection, and cancellation.
- FELTUS CODE planning streams through the configured provider when supported. The provider adapter stream/usage mapping and cancellation path pass automated tests; endpoint policy gates source context and code prompts never append stored conversation history.
- `npm run check`, `npm run test:core`, `npm run test:code`, and `npm run regression` passed for the current working tree. Regression covers anonymous FELTUS CODE API/UI denial, project-scoped migration policies, model selection, cancellation, secret scan, and Compose validation.
- PDF extractor tests passed (2 tests); Compose configuration and production workflow YAML validation passed.
- Native Windows Ollama was previously verified for local development. No Docker Ollama container was started. Docker access in this recovery run was limited to disposable Postgres validation containers.
- FELTUS Deployment Control Plane Database v1 has passed isolated PostgreSQL migration checks. This does not verify live staging/production RLS, Coolify integration, or public availability.

## BLOCKED

- PR and clean-checkout CI: PR #2 was merged before this recovery diff; these local recovery changes are uncommitted and have no CI run.
- Staging deployment and clean staging database migrations: not completed.
- Live project/data isolation against a running self-hosted stack: not completed.
- FELTUS CODE migration `20261102010000_feltus_code.sql` has not been applied to a clean staging Postgres database; its RLS behavior has only been checked through static regression plus unit tests, not a live database.
- The migration has passed the disposable PostgreSQL checks described above. Live staging grants/RLS, concurrent delivery, and worker lease recovery still need verification on the isolated staging stack before enabling the Coolify worker.
- A browser-level FELTUS CODE flow against authenticated live project data (workspace initialization, file edit, streamed Plan, accepted Edit, and persisted action/checkpoint) has not been run.
- Coolify production configuration and production secrets: not configured or verified.
- Production Docker image build and runtime behavior: local Compose validation is separate from building/running the production stack; production-environment verification remains open.
- Production runtime startup and health: local images built successfully, but no Compose services were started. Run an isolated staging deployment and retain startup/health logs.
- Owner bootstrap and production login: not verified.
- SMTP and owner password recovery end-to-end: not verified.
- Backup and restore: automated backup artifacts exist, but a successful off-host backup and full restore drill have not been verified.
- Rollback drill: not completed.
- Production/runtime AI provider ownership and network access: not verified from Coolify or the actual runtime environment. Select and verify one supported provider, its exact trust classification, and any runtime credential.
- The recovery diff still needs a reviewed PR/clean-checkout CI run before promotion.

## NOT TESTED

- Public DNS and TLS for `feltuslabs.com` and `www.feltuslabs.com`.
- Staging browser security and full user flows.
- Runtime persistence across actual production container/server restarts.
- Cross-project isolation with separate live users/projects and document/conversation records.
- Cross-project FELTUS CODE workspace isolation with two authenticated live project memberships.
- Browser visual/usability verification of the embedded FELTUS CODE UI.
- The configured self-hosted AI runtime endpoint has not been verified from this workspace shell or Coolify.
- Live staging and production migration/RLS behavior and legacy-data preservation have not been verified; only disposable databases were used.
- No Git provider webhook, build runner, OCI registry publisher, or artifact promotion flow has been implemented. The outbox worker and Coolify adapter are implemented locally but have not been run against Coolify.

## REQUIRES PRODUCTION INFRASTRUCTURE

- Coolify host/project, domain routing, DNS records, and TLS certificates.
- Secret values stored in Coolify, including database/JWT/Auth keys, owner bootstrap credential (temporary), evidence-extractor token, and SMTP credentials.
- A reachable, approved AI runtime configured as `ollama`, `openai_compatible`, `vllm`, or `llama_cpp`, with exact trust/allowlist settings. Keep `FELTUS_AI_SEND_HISTORY=false` until the endpoint is verified; enable project context only after the destination is approved for that data.
- Staging and production database volumes, backup destination, encrypted off-host retention, and separate restore/rollback targets.
- A staging project/database and test users for live FELTUS CODE RLS and workspace-isolation checks.
- SMTP provider access and a mailbox for end-to-end recovery validation.

The data model supports project memberships and roles, but the current browser sign-in surface remains intentionally owner-operated until invitations and member-login administration are exposed. Builder, workflow engine, billing, and commercial features remain outside this production-readiness scope.

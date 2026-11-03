# FELTUS go-live status

Status for the core-platform branch as of 2026-11-02. Local code checks do not verify a public deployment. FELTUS remains a **production candidate**, not a production-ready service, until every blocked infrastructure gate below is completed.

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
- Native Windows Ollama is the only local runtime verified in this session: `ollama.exe` owns loopback port `11434`, `llama3:8b` is installed, and a harmless local-only inference prompt returned successfully. No Docker Ollama container was started; Docker Desktop's Linux engine is unavailable.
- FELTUS Deployment Control Plane Database v1 migration and schema documentation have been added on `codex/feltus-code-integration`. The design reuses existing project and deployment records and adds organization/RBAC, environments, Git/build/artifact records, deployment history, secret metadata, audit events, and a transactionally enqueued leased outbox. This is a code artifact only; it is not evidence of a successful database migration or live RLS verification.

## BLOCKED

- PR and clean-checkout CI: no PR has been opened and a GitHub Actions run has not been confirmed for this revision.
- Staging deployment and clean staging database migrations: not completed.
- Live project/data isolation against a running self-hosted stack: not completed.
- FELTUS CODE migration `20261102010000_feltus_code.sql` has not been applied to a clean staging Postgres database; its RLS behavior has only been checked through static regression plus unit tests, not a live database.
- Deployment control plane migration `20261102020000_feltus_deployment_control_plane.sql` has not been executed or validated by PostgreSQL. The local Docker Engine was unavailable during this implementation, so migration syntax, existing-data backfill, grants, triggers, and RLS must be verified against a disposable clean database and then staging before workers or UI use these tables.
- Deployment/build/outbox worker RPCs have not been exercised under concurrent transactions. Do not enable an infrastructure worker until duplicate delivery, lease recovery, rollback, and cross-tenant integration cases pass against the applied schema.
- A browser-level FELTUS CODE flow against authenticated live project data (workspace initialization, file edit, streamed Plan, accepted Edit, and persisted action/checkpoint) has not been run.
- Coolify production configuration and production secrets: not configured or verified.
- Production Docker image build and runtime behavior: local Compose validation is separate from building/running the production stack; production-environment verification remains open.
- Local production image build: Docker Desktop's Linux engine was unavailable in this workspace, so `docker compose ... build app worker evidence-extractor` could not connect to the Docker API. Run the existing CI build or a Coolify/staging build and retain its logs.
- Owner bootstrap and production login: not verified.
- SMTP and owner password recovery end-to-end: not verified.
- Backup and restore: automated backup artifacts exist, but a successful off-host backup and full restore drill have not been verified.
- Rollback drill: not completed.
- Production/runtime AI provider ownership and network access: not verified from Coolify or the actual runtime environment. Select and verify one supported provider, its exact trust classification, and any runtime credential.
- Branch is not yet pushed through a PR/clean-checkout CI run; open the PR only after reviewing the complete branch diff and confirm all required CI jobs pass.

## NOT TESTED

- Public DNS and TLS for `feltuslabs.com` and `www.feltuslabs.com`.
- Staging browser security and full user flows.
- Runtime persistence across actual production container/server restarts.
- Cross-project isolation with separate live users/projects and document/conversation records.
- Cross-project FELTUS CODE workspace isolation with two authenticated live project memberships.
- Browser visual/usability verification of the embedded FELTUS CODE UI.
- The configured self-hosted AI runtime endpoint has not been verified from this workspace shell or Coolify.
- The new deployment control plane migration has not been applied to any database; DDL/RLS behavior and legacy project/deployment backfills are untested.
- No Git provider webhook, build runner, OCI registry publisher, Coolify deployment adapter, promotion, or infrastructure outbox worker has been implemented or run by this database-only phase.

## REQUIRES PRODUCTION INFRASTRUCTURE

- Coolify host/project, domain routing, DNS records, and TLS certificates.
- Secret values stored in Coolify, including database/JWT/Auth keys, owner bootstrap credential (temporary), evidence-extractor token, and SMTP credentials.
- A reachable, approved AI runtime configured as `ollama`, `openai_compatible`, `vllm`, or `llama_cpp`, with exact trust/allowlist settings. Keep `FELTUS_AI_SEND_HISTORY=false` until the endpoint is verified; enable project context only after the destination is approved for that data.
- Staging and production database volumes, backup destination, encrypted off-host retention, and separate restore/rollback targets.
- A staging project/database and test users for live FELTUS CODE RLS and workspace-isolation checks.
- SMTP provider access and a mailbox for end-to-end recovery validation.

The data model supports project memberships and roles, but the current browser sign-in surface remains intentionally owner-operated until invitations and member-login administration are exposed. Builder, workflow engine, billing, and commercial features remain outside this production-readiness scope.

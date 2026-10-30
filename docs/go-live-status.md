# FELTUS go-live status

Status for the production-readiness branch as of 2026-10-30. Local code checks do not verify a public deployment. FELTUS remains a **production candidate**, not a production-ready service, until every blocked infrastructure gate below is completed.

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

## BLOCKED

- PR and clean-checkout CI: no PR has been opened and a GitHub Actions run has not been confirmed for this revision.
- Staging deployment and clean staging database migrations: not completed.
- Live project/data isolation against a running self-hosted stack: not completed.
- Coolify production configuration and production secrets: not configured or verified.
- Production Docker image build and runtime behavior: local Compose validation is separate from building/running the production stack; production-environment verification remains open.
- Owner bootstrap and production login: not verified.
- SMTP and owner password recovery end-to-end: not verified.
- Backup and restore: automated backup artifacts exist, but a successful off-host backup and full restore drill have not been verified.
- Rollback drill: not completed.
- Production/runtime Ollama-compatible endpoint ownership and network access: not verified from Coolify or the actual runtime environment.

## NOT TESTED

- Public DNS and TLS for `feltuslabs.com` and `www.feltuslabs.com`.
- Staging browser security and full user flows.
- Runtime persistence across actual production container/server restarts.
- Cross-project isolation with separate live users/projects and document/conversation records.
- Native Windows Ollama at `http://127.0.0.1:11434` could not be verified from this workspace shell (read-only `/api/tags` request failed); no Ollama Docker container or process was changed during this work.

## REQUIRES PRODUCTION INFRASTRUCTURE

- Coolify host/project, domain routing, DNS records, and TLS certificates.
- Secret values stored in Coolify, including database/JWT/Auth keys, owner bootstrap credential (temporary), evidence-extractor token, and SMTP credentials.
- A reachable, approved private AI endpoint with exact allowlist configuration, or an intentionally limited deployment with AI unavailable. Keep `FELTUS_AI_SEND_HISTORY=false` until the endpoint is verified; enable project context only after the destination is approved for that data.
- Staging and production database volumes, backup destination, encrypted off-host retention, and separate restore/rollback targets.
- SMTP provider access and a mailbox for end-to-end recovery validation.

Organizations/RBAC expansion, builder, workflow engine, billing, and commercial features remain out of this production-readiness scope. The current product is a single configured owner deployment.

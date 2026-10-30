# FELTUS current architecture

**Repository:** `kymfeltus-oss/feltus`
**Baseline inspected:** `main` at `484cb4e` (`Complete FELTUS production readiness verification`)
**State date:** 2026-10-30

This document describes the implementation in the repository. It does not claim that a production server, DNS, TLS, backups, or external accounts have been configured.

## Runtime topology

The browser loads the single-page FELTUS application from the Node.js server. In production the server requires the configured owner to sign in, keeps Auth access and refresh tokens in process memory, and sets an opaque secure session cookie. Auth, REST, Realtime, and Storage APIs are supplied by the self-hosted Supabase-compatible services in the Compose stack. The Nginx gateway and all service ports stay on the private Compose network; Coolify's reverse proxy is intended to be the public ingress.

Production services are declared in `compose.production.yaml`:

- `app`: Node.js 22 Alpine runtime, listening on container port 8080.
- `db`: Supabase Postgres 17 image, with its data in `feltus_postgres`.
- `auth`: GoTrue, with public signups disabled.
- `rest`: PostgREST for the database API.
- `realtime`: Supabase Realtime.
- `storage`: Supabase Storage API, with objects in `feltus_object_storage`.
- `imgproxy`: image transformations, read-only access to object storage.
- `gateway`: private Nginx routing to Auth, REST, Realtime, and Storage.
- `migrate`: one-shot, transactional application of timestamped SQL migrations.
- `evidence-extractor`: private PDF text/layout extraction, read-only access to the application document volume and bearer-token protected.
- `owner-bootstrap`, `backup-storage`, and `restore-storage`: opt-in bootstrap and maintenance profiles.

The app's uploaded documents and immutable PDF evidence sidecars use `feltus_documents`. The application database, document files, and Supabase Storage objects therefore have separate persistent volumes. `scripts/backup.sh` backs up the database, both file volumes, and a permission-restricted deployment configuration snapshot. Off-host encrypted copies and scheduled retention are host-operator responsibilities.

## Development and production configuration

`npm run dev` is the approved Windows-local path. It selects the local Supabase-compatible gateway at `127.0.0.1:54321` and native Windows Ollama at `127.0.0.1:11434`; it does not start a Docker Ollama service or point at hosted Supabase. Local data remains under `.feltus-storage` and Supabase's local data directories.

`npm start` and the production Docker image require production-mode configuration. Coolify supplies the self-hosted gateway address, publishable JWT, owner email, allowed origins, AI endpoint/model and trust classification, storage path, and private evidence-extractor settings. Database, JWT, Auth, and extractor secrets belong in Coolify's secret fields and are not committed. The production endpoint uses `FELTUS_AI_ENDPOINT` (with `FELTUS_AI_BASE_URL` as a compatibility alias) and is separate from the native Windows development default. Private endpoints require private DNS/IP validation and an exact private host allowlist; trusted external endpoints require HTTPS and an exact trusted-host allowlist.

## Authentication and authorization

The current product supports a single configured owner account (`FELTUS_OWNER_EMAIL`) and does not expose public signup. The one-time bootstrap profile creates that account. The session cookie is `HttpOnly`, `Secure`, `SameSite=Strict`, and scoped with the `__Host-` prefix. Tokens stay in process memory, so an app restart invalidates browser sessions. The sign-in page supports owner-only email recovery through the local Auth service when SMTP is configured. Recovery tokens are read from the URL fragment, removed from browser history, and held in memory only while the password is updated. Login attempts, recovery requests, and expensive operations have in-process rate limits; these limits reset on restart and do not coordinate across replicas.

Database tables use authenticated access and row-level security policies tied to the current user's owned application. AI conversation records are scoped by authenticated owner and application. This is an owner-only deployment model: organization membership, role-based access, invitations, and commercial multi-tenant administration are not implemented in this revision.

## AI and document data flow

Browser AI requests go to the FELTUS server. The server selects the configured model/capability, validates the AI endpoint trust policy, verifies the requested project belongs to the authenticated owner, and conditionally sends project/document grounding. The current user prompt is sent to the configured endpoint. Stored project context defaults off in production Compose and is sent only when `FELTUS_AI_SEND_PROJECT_CONTEXT=true`; external endpoints require explicit opt-in. Redirects from the configured AI endpoint are blocked.

Conversations are saved in Postgres and restored in the project UI. Prior turns remain excluded by default because `FELTUS_AI_SEND_HISTORY=false`; if explicitly enabled for a verified trust class, the server loads at most 20 recent turns after rechecking the authenticated owner, `app_id`, active `conversation_id`, and message row scope. Browser-supplied history is ignored. `external_unverified` never receives stored prior turns. Payload order is system instructions, optional project context, optional authorized recent turns, retrieved project/document context, and the current prompt. PDF extraction remains inside the Compose network, checks a private bearer token, reads the document volume read-only, limits document size, and returns page-aware text/evidence to the app.

## Health, observability, and persistence boundaries

- `GET /api/health` reports process liveness and is used by the container healthcheck.
- `GET /api/ready` checks required self-hosted dependencies, including database/Auth and the PDF extractor. AI is optional and does not gate readiness.
- Responses include `X-Request-ID`; request IDs are attached to supported activity/error telemetry.
- The current rate limiter and session registry are process-local. A restart clears both.
- Compose uses named volumes and `restart: unless-stopped`; this provides persistence across container recreation on the same host, not disaster recovery by itself.
- Database dump listing has been checked, but a full restore drill and off-host recovery have not been verified in the current environment.

## Known production gates

The repository contains a deployable Compose definition and automated code-level checks. A real public launch still requires a Coolify host/repository resource, production secret values, DNS records, TLS issuance, owner bootstrap, SMTP decision/testing, backup schedule and off-host copy, and a tested restore. Those external actions have not been performed from this checkout. Multi-user/organization access and the broader builder, workflow, billing, and administration roadmap are also outside the implemented owner-only release.

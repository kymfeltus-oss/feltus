# FELTUS production deployment

This runbook deploys the FELTUS app and its self-hosted Supabase-compatible services from GitHub. It does not use Supabase hosted services.

For the code-level architecture and route inventory, see [current state](docs/architecture/current-state.md) and [current API](docs/api/current-api.md). For environment gates that require access to the production host or domain, see [go-live status](docs/go-live-status.md).

## Coolify resource

This runbook targets Production and uses `compose.production.yaml`. The Staging deployment must use `compose.staging.yaml`; its BuildKit credential file mounts and migration procedure are documented in [the isolated build worker guide](docs/build-worker.md#staging-credential-rotation). Do not switch the Production resource to the Staging Compose file.

1. Push the reviewed `main` branch to `https://github.com/kymfeltus-oss/feltus`.
2. In Coolify, create an application from that Git repository and select the [Docker Compose build pack](https://coolify.io/docs/applications/builds/docker-compose).
3. Set the Compose file path to `compose.production.yaml` and the app service domain to `https://feltuslabs.com,https://www.feltuslabs.com`, targeting the app service's internal port `8080`. Do not publish ports for the other services.
4. Configure the environment below as Coolify runtime variables. Keep the password and signing values in Coolify's secret fields; never commit a populated `.env`.
5. Build and deploy. The Compose dependency graph starts the private database, Auth, REST, Realtime, Storage, image proxy, gateway, migrations, internal evidence extractor, durable worker, and FELTUS app. The app becomes healthy when its HTTP liveness route responds; use `/api/ready` to check database, Auth, and evidence-extraction readiness.
6. Assign DNS `A` for `feltuslabs.com` to the Coolify server's public IPv4. Add `AAAA` only if IPv6 is enabled and reachable. Point `www` to the apex with a `CNAME` (or the server address). In Coolify, issue TLS certificates for both names and force HTTPS. The app redirects `www` to the canonical apex URL.

Coolify's proxy is the only public ingress. Compose declares internal `expose` ports and no host `ports`; Postgres, PostgREST, Realtime, Storage, the evidence extractor, and the Nginx gateway remain on the private Compose network. FELTUS forwards the Auth API under the same site's `/auth/v1` path so owner sign-in and optional recovery email links work without exposing the database, Storage API, or extraction service.

## Required variables

Start from `.env.example` and replace every placeholder. Set the values in Coolify's Compose environment settings:

| Variable | Purpose |
| --- | --- |
| `FELTUS_PUBLIC_URL` | Canonical HTTPS URL, normally `https://feltuslabs.com`. |
| `FELTUS_ALLOWED_ORIGINS` | Comma-separated HTTPS origins, normally apex and `www`. |
| `FELTUS_OWNER_EMAIL` | The only owner address allowed to sign in. |
| `POSTGRES_PASSWORD` | Long random **alphanumeric** password shared by the internal service roles; URL-safe characters avoid connection-string parsing issues. |
| `JWT_SECRET` | At least 32 random bytes used to sign local Supabase-compatible JWTs. |
| `ANON_KEY` | Local anon JWT signed with `JWT_SECRET` and role `anon`. This public key is delivered only to the FELTUS app and internal Storage service. |
| `SERVICE_ROLE_KEY` | Local service-role JWT signed with the same `JWT_SECRET`; supplied only to internal Storage, app, worker, and one-time owner-bootstrap containers. Never expose it to the browser. |
| `FELTUS_SECRET_ENCRYPTION_KEY` | Separate 32+ character key used only by the app's server-side secret-storage RPC. Never expose it to the browser. |
| `SECRET_KEY_BASE` | At least 64 random characters for Realtime. |
| `REALTIME_DB_ENC_KEY` | Separate random 16-character key used by Realtime to encrypt database settings. |
| `FELTUS_BACKUP_DIR` | Absolute host directory for database and file archives, such as `/srv/backups/feltus`; create it on the Coolify host first and restrict access. |
| `FELTUS_EVIDENCE_EXTRACTION_TOKEN` | Random service-to-service bearer secret (at least 32 characters) shared only by the FELTUS app and private PDF extractor. |

Generate unique values from the upstream [self-hosted key generator](https://github.com/supabase/supabase/blob/master/docker/utils/generate-keys.sh) or a trusted password manager, then copy only the required values into Coolify's secret fields. Create the anon and service role JWTs from the same JWT secret. Do not reuse keys from a hosted Supabase project. Use URL-safe, alphanumeric characters for `POSTGRES_PASSWORD` because internal service URLs embed it. Realtime's encryption key must be exactly 16 characters.

The optional `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_SENDER_NAME` enable Auth email delivery and password recovery. Without SMTP, owner password sign-in still works, but email-based password recovery is unavailable. The sign-in screen's recovery action always targets the configured owner mailbox, returns a generic response, and is rate-limited. Verify the recovery email, reset password, then sign in again before treating recovery as production-ready. The signup endpoint is disabled, and owner sign-in requests are throttled.

Configure the AI endpoint separately from the Windows-local baseline. `FELTUS_AI_PROVIDER` supports `ollama`, `openai_compatible`, `vllm`, and `llama_cpp`; `FELTUS_AI_ENDPOINT` is preferred and `FELTUS_AI_BASE_URL` remains a compatibility alias. Set `FELTUS_AI_RUNTIME_KEY` only for an internal runtime that requires bearer authentication. `FELTUS_AI_ENDPOINT_TRUST` is one of `local_private`, `private_managed`, `external_trusted`, or `external_unverified`. Loopback/private classifications are validated server-side; non-loopback private hosts must resolve only to private addresses and exactly match `FELTUS_AI_ALLOWED_PRIVATE_HOSTS`. `external_trusted` requires HTTPS and an exact `FELTUS_AI_TRUSTED_HOSTS` hostname. AI redirects are rejected.

`FELTUS_AI_SEND_HISTORY` defaults to `false` for every classification. Set it to `true` only after the endpoint trust and ownership checks are verified; `external_unverified` never receives stored prior turns. Conversation history stays in FELTUS Postgres and is loaded only by the server after matching authenticated owner, project, and active conversation, with a maximum of 20 recent messages. `FELTUS_AI_SEND_PROJECT_CONTEXT` defaults off in the production Compose template; project assets, metadata, and retrieved document context are sent only when enabled. `external_trusted` requires this explicit opt-in; `external_unverified` has no project context by default. `FELTUS_AI_MAX_HISTORY_MESSAGES` accepts 1–20. `FELTUS_AI_MODEL` selects the default installed model; capability routing can choose specialized installed models.

Compose supplies `FELTUS_EVIDENCE_EXTRACTION_URL` as the private `evidence-extractor` service address and sets a three-minute request timeout. Generate a unique `FELTUS_EVIDENCE_EXTRACTION_TOKEN` and store it as a Coolify secret; the app and extractor require it for every extraction request. Do not publish the extractor port or route it through Coolify. It receives only an RLS-authorized document's internal storage key and SHA-256 fingerprint, mounts the existing FELTUS document volume read-only, and returns page-preserving PDF evidence to the app service.

## Owner account bootstrap

The Compose stack starts with public signups disabled. Set `FELTUS_OWNER_PASSWORD` temporarily as a Coolify secret, then run this one-time command from the deployment checkout on the Coolify host:

```sh
docker compose --env-file .env -f compose.production.yaml --profile bootstrap run --rm owner-bootstrap
```

The bootstrap creates the configured owner only when the account does not already exist; it does not reset an existing password. Remove `FELTUS_OWNER_PASSWORD` from deployment variables after successful creation and store the credential in the owner's password manager. Sign in at the site using the owner email and password.

The browser receives an opaque, `HttpOnly`, `Secure`, `SameSite=Strict` session cookie. Access and refresh tokens stay in the app process; restarting the app expires existing sessions and requires sign-in again.

The rate limits are also process-local: 10 failed owner logins per IP/email per 15 minutes, 5 recovery requests per IP per hour, 20 AI requests per owner/IP per minute, 20 uploads per owner/IP per hour, and 30 document-processing requests per owner/IP per hour. A `X-Request-ID` response header is attached to requests and carried into activity/error telemetry where available. These in-memory limits do not coordinate across multiple app replicas.

## Persistence, updates, and backups

Compose named volumes persist the Postgres database (`feltus_postgres`), FELTUS documents (`feltus_documents`), Supabase-compatible Storage objects (`feltus_object_storage`), and per-project FELTUS CODE repositories (`feltus_code_workspaces`) across container recreation and host restarts. Successful and review-required PDF runs also preserve immutable evidence sidecars in the existing `feltus_documents` volume; the authenticated document metadata contains the sidecar fingerprint and private storage key. Do not remove these volumes during upgrades. SQL migrations run in filename order and record applied migrations in a private ledger; each migration is executed in a transaction.

AI conversations are persisted per authenticated owner and project in `feltus_ai_conversations` and `feltus_ai_messages`. The core-platform migration `20261102000000_feltus_core_platform.sql` adds multi-conversation chat, per-chat model/system/temperature/token controls, export/archive, encrypted project-secret metadata, knowledge bases, usage records, deployment records, durable jobs, worker heartbeats, and audited safe tools. The UI sends the selected model and chat controls through the authenticated backend; history and project grounding still respect the runtime trust policy.

The worker has no public port. It claims general jobs with database row locks, renews a heartbeat, recovers expired leases, applies bounded retries, and honors cancellation. It also has a separate infrastructure-outbox consumer that uses the outbox lease-token RPCs, revalidates artifacts and targets, and calls Coolify from the worker only. The Coolify API URL, API token, allowed environment list, and `FELTUS_COOLIFY_RESOURCE_MAP` are worker-only settings. The resource map must identify the exact Coolify resource UUID for each enabled FELTUS environment; leave both the allowlist and map empty until staging isolation and mappings are verified. Production requires both `production` in the allowlist and `FELTUS_COOLIFY_PRODUCTION_ENABLED=true`. Production teardown is always rejected. Use a Coolify token scoped to the intended team with only `read`, `write`, and `deploy` permissions; do not grant `read:sensitive` or `root`. Set `FELTUS_COOLIFY_ALLOW_HTTP=true` only for a trusted private-network Coolify endpoint. See [deployment control plane](docs/deployment-control-plane-schema.md) for the command and health-check behavior. `/api/system-health` reports database, Auth, Storage, Realtime, worker, and AI runtime status together.

FELTUS CODE workspaces live in the named `feltus_code_workspaces` volume and are project-scoped by FELTUS application UUID. The application container runs as `node`; the image prepares the mount path with writable ownership. The same volume is included in `backup-storage` and `restore-storage`. Use `npm run test:code` to verify file safety, secret redaction, exact Git-root isolation, and allowlisted task execution. See [FELTUS CODE integration](docs/integration/feltus-code.md) for the UI/editor boundary and API behavior.

Create and protect the host backup directory, then run `scripts/backup.sh` from the Compose checkout. It creates a private timestamped directory containing a custom-format Postgres dump, verified tar archives for the three persistent file volumes, and a permission-restricted `deployment.env` snapshot of the Compose configuration. The host scheduler needs the same Compose variables and project name as Coolify; keep a host-side `.env` with mode `0600` or use `FELTUS_ENV_FILE` to point at another protected file. If Coolify chose a project name other than `feltus`, set `COMPOSE_PROJECT_NAME` for the backup job. Schedule the command daily with the host's scheduler and copy backups to a separate encrypted location with an appropriate retention policy. The backup command never prints secrets or deletes application data or prior backups.

For example, install a 0700 backup directory and run the backup at 03:15 UTC each day:

```sh
sudo install -d -m 700 /srv/backups/feltus
15 3 * * * cd /path/to/feltus && /usr/bin/flock -n /run/lock/feltus-backup.lock ./scripts/backup.sh >> /var/log/feltus-backup.log 2>&1
```

To restore a selected snapshot, preserve the current volumes as a separate recovery point and create a new Compose project so its named volumes start empty. Set `snapshot` to the timestamped backup directory name, then run:

```sh
snapshot=20261026T031500Z-1234
backup_dir=/srv/backups/feltus
env_file="$backup_dir/$snapshot/deployment.env"
restore_project="feltus-recovery-$(printf '%s' "$snapshot" | tr '[:upper:]' '[:lower:]')"

docker compose --project-name "$restore_project" --env-file "$env_file" --file compose.production.yaml up -d db
docker compose --project-name "$restore_project" --env-file "$env_file" --file compose.production.yaml exec -T db pg_restore --list - < "$backup_dir/$snapshot/postgres.dump"
docker compose --project-name "$restore_project" --env-file "$env_file" --file compose.production.yaml exec -T db pg_restore --clean --if-exists --no-owner -U postgres -d postgres < "$backup_dir/$snapshot/postgres.dump"
docker compose --project-name "$restore_project" --env-file "$env_file" --file compose.production.yaml --profile maintenance run --rm -e FELTUS_BACKUP_TIMESTAMP="$snapshot" restore-storage
```

After checking the restored database and files, stop writes on the old stack, configure the Coolify Compose resource to adopt that exact project name, and deploy the app and remaining services. This avoids extracting backup files into non-empty volumes. Database restoration replaces database objects; preserve the original volumes until recovery is confirmed.

To update, deploy the reviewed Git revision through Coolify; retain the database and file volumes. Before a schema-changing update, take a backup and keep the prior Git revision available for rollback.

## Verification

From a checkout with Node.js installed:

```sh
npm ci
npm run check
npm run test:core
npm run test:code
npm run regression
```

The regression command checks AI routing and UI controls, project-scoped conversation storage, production cookie/auth boundaries, request limits and trace IDs, committed-file secret patterns, Compose configuration, and directly invokes the production HTTP handler with isolated synthetic requests. It verifies that liveness remains online when the backend is unavailable, readiness reports the unavailable dependencies, and protected routes, including FELTUS CODE, require a session. To check an already deployed instance's public health and unauthenticated access gate, set `FELTUS_REGRESSION_BASE_URL=https://feltuslabs.com` before running it. `/api/health` is liveness; `/api/ready` reports database, Auth, and evidence-extraction availability. AI is optional and does not affect readiness.

The regression also verifies that PDF extraction remains private, read-only against the document volume, and required by production readiness. The extractor image compiles its Python application during the Docker build. For a direct source-level extraction check, install `services/evidence-extractor/requirements.txt` in an isolated Python 3.12 environment and run `python -m unittest discover -s tests -v` from that service directory.

For a read-only local integration run, start `npm run dev` with the local Supabase-compatible services and native Ollama available. Set `FELTUS_LOCAL_REGRESSION_URL` to that local app URL and `FELTUS_LOCAL_REGRESSION_APP_ID` to an existing application containing the verification document, then run `npm run regression`. This exercises readiness, existing application/document/model/relationship reads, AI status and routing, and reconstructs the stream tokens before checking the document marker. The test does not add records or print document text.

For local development, use `npm run dev`. It deliberately selects the local Supabase-compatible gateway at `http://127.0.0.1:54321`, discovers its local publishable key through `supabase status`, uses native Windows Ollama at `http://127.0.0.1:11434` (`local_private`), and keeps data under `.feltus-storage`. History remains off unless explicitly opted in. If local ports differ, set the `FELTUS_LOCAL_GATEWAY_URL`, `FELTUS_LOCAL_PUBLISHABLE_KEY`, or `FELTUS_LOCAL_AI_BASE_URL` overrides. PDF processing additionally requires a locally started evidence extractor, `FELTUS_EVIDENCE_EXTRACTION_URL`, and a private `FELTUS_EVIDENCE_EXTRACTION_TOKEN`; other native text formats continue to work when it is absent. The local entrypoint ignores production API keys and URLs so it cannot silently target a hosted Supabase project. `npm start` runs the production server and requires production configuration.

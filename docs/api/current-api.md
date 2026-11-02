# Current FELTUS API inventory

This is a route inventory of `src/server.js` at baseline `484cb4e` plus the current working-tree implementation. It is intended for deployment and maintenance, not as a promise that every response shape is a stable third-party API contract. Application routes return JSON unless they are streaming or serve the HTML app.

## Authentication model

Production browser sessions use the secure `__Host-feltus_session` cookie. `/api/auth/login`, `/api/auth/logout`, `/api/auth/session`, `/api/health`, and `/api/ready` are handled before the owner-session gate. Other `/api/*` routes require an authenticated owner session. Project IDs and conversation IDs are checked against the authenticated owner; database RLS is an additional boundary. The Auth proxy is same-origin under `/auth/v1/*`, and public signup is disabled in production. Recovery requests are limited to the configured owner and protected by an application rate limit plus Auth's own rate limits.

Requests with an unapproved `Origin` are rejected. Mutating operations use JSON request bodies except document upload, which uses multipart form data. Unsupported methods return `405` on routes with explicit method checks; unknown paths return `404`.

## Routes

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/` and `/index.html` | Public | Serve the FELTUS single-page application. |
| `GET` | `/api/health` | Public | Process liveness. |
| `GET` | `/api/ready` | Public | Dependency readiness for required backend services and PDF extraction. |
| `GET` | `/api/auth/session` | Public | Report whether the browser has an authenticated session; refreshes/clears stale sessions as needed. |
| `POST` | `/api/auth/login` | Public, throttled | Authenticate the configured owner and set the session cookie. |
| `POST` | `/api/auth/logout` | Public | Clear the session cookie and in-process session. |
| `*` | `/auth/v1/*` | Auth proxy | Same-origin Supabase-compatible Auth API proxy; public signup is disabled. |
| `POST` | `/auth/v1/recover` | Public, throttled | Request recovery for the configured owner only; the submitted address is ignored and every response is generic. The redirect destination is fixed to `FELTUS_PUBLIC_URL`. |
| `GET` | `/auth/v1/verify` | Public | Verify Auth email-action links. Recovery redirects are forwarded only when their destination origin is configured in the allowed-origin list. |
| `PUT` | `/auth/v1/user` | Recovery access token | Set the new password from a recovery flow. The application reads the access token from the URL fragment, removes the fragment from browser history, and keeps the token in memory while the password is changed. |
| `GET`, `POST` | `/api/apps` | Owner | List owned applications or create an application. |
| `GET` | `/api/documents` | Owner | List authorized project documents and processing metadata. |
| `GET` | `/api/document-chunks` | Owner | Read authorized extracted document chunks. |
| `GET` | `/api/documents/extraction` | Owner | Read extraction status/evidence metadata. |
| `POST` | `/api/documents/upload` | Owner, throttled | Upload and register a project document. |
| `POST` | `/api/documents/process` | Owner, throttled | Process an authorized document and persist extraction results. |
| `GET`, `POST` | `/api/deployment` | Owner | Read or update a project's deployment state/configuration. |
| `GET` | `/api/ai/route` | Owner | Inspect available model/capability routing. |
| `GET` | `/api/ai/models` and `/api/ai/models/:id` | Owner | List runtime-discovered model metadata or one model. |
| `GET` | `/api/ai/runtime/health` | Owner | Report provider-neutral runtime health, model count, and latency without credentials. |
| `POST` | `/api/ai/embeddings` | Owner | Generate bounded project-authorized embeddings. |
| `GET`, `POST` | `/api/ai/conversations` | Owner | List/search project conversations or create a new conversation with initial controls. |
| `GET`, `PATCH`, `DELETE` | `/api/ai/conversations/:id` | Owner | Read, export, edit controls/archive, or soft-delete an authorized conversation. |
| `GET`, `POST` | `/api/ai/conversation` | Owner | Retrieve or create the authenticated owner's project conversation. |
| `GET`, `DELETE` | `/api/ai/messages` | Owner | Read or clear messages for an authorized project conversation. |
| `GET` | `/api/ai/status` | Owner | Report AI endpoint/model availability. |
| `GET`, `POST` | `/api/jobs` | Owner | List or enqueue a bounded durable project job. |
| `GET`, `DELETE` | `/api/jobs/:id` | Owner | Read job status or request cancellation. |
| `GET` | `/api/tools` | Owner | List built-in, allowlisted tools. |
| `POST` | `/api/tools/execute` | Owner | Execute an audited, project-scoped safe tool. |
| `GET`, `POST`, `DELETE` | `/api/secrets` | Owner | List encrypted-secret metadata, write a secret, or delete it; plaintext is never returned. |
| `GET`, `POST` | `/api/knowledge-bases` | Owner | List or create a project knowledge base. |
| `GET` | `/api/usage` | Owner | Read project AI usage records. |
| `GET`, `POST` | `/api/deployments/history` | Owner | Read or record Coolify-oriented deployment history. |
| `GET` | `/api/system-health` | Owner | Read application dependency and system status. |
| `GET` | `/api/activity` | Owner | Read project activity events. |
| `POST` | `/api/ai/chat` | Owner, throttled | Send a non-streaming project-grounded AI request. |
| `POST` | `/api/ai/chat/stream` | Owner, throttled | Send a project-grounded AI request as a token stream. |
| `GET` | `/api/code/ui` and `/code-assets/*` | Authenticated FELTUS session | Serve the FELTUS CODE workspace frame and its fixed same-origin JavaScript/CSS assets. |
| `GET`, `POST` | `/api/code/workspace` | Authenticated project member; write permission for initialization | Read workspace state or create a private empty Git repository for the selected FELTUS project. The server derives its filesystem root from the authorized application ID. |
| `GET`, `POST` | `/api/code/session` | Authenticated project member; write permission to create | Read or create the project's active FELTUS CODE session. |
| `GET` | `/api/code/tree`, `/api/code/file`, `/api/code/search`, `/api/code/repo-map` | Authenticated project member | Read a bounded repository tree, file, search result, or repo map. Secret paths are excluded or redacted. |
| `PUT`, `POST`, `DELETE` | `/api/code/file`, `/api/code/file/create`, `/api/code/directory`, `/api/code/rename` | Authenticated project member with write permission | Operate on relative paths inside the selected project's workspace; writes require an expected SHA-256 and deletion requires explicit confirmation. |
| `GET`, `POST` | `/api/code/git/status`, `/api/code/git/diff`, `/api/code/git/log`, `/api/code/git/stage`, `/api/code/git/checkpoint` | Authenticated project member; write permission for stage/checkpoint | Read Git state, explicitly stage selected paths, or commit staged changes after confirmation. Git requires a direct `.git` entry and exact `rev-parse --show-toplevel` match; FELTUS CODE never pushes or merges. |
| `GET`, `POST` | `/api/code/tasks`, `/api/code/task` | Authenticated project member; write permission to run | List/run server-side allowlisted validation tasks; arbitrary shell commands are rejected. |
| `POST` | `/api/code/ai/plan`, `/api/code/ai/plan/stream` | Authenticated project member with write permission | Generate a plan through the configured FELTUS AI Gateway; the stream route returns newline-delimited JSON and cancels inference on disconnect. |
| `POST` | `/api/code/ai/edit`, `/api/code/ai/apply`, `/api/code/ai/agent` | Authenticated project member with write permission | Propose selected-file edits, apply only accepted edits with unchanged source hashes, or run a confirmed allowlisted agent task. Project source is blocked unless endpoint policy permits it. |
| `GET` | `/api/model-columns` | Owner | Read columns for an authorized model/table. |
| `GET`, `POST` | `/api/relationships` | Owner | Read or create project model relationships. |
| `POST` | `/api/relationships/delete` | Owner | Delete an authorized model relationship. |
| `GET`, `POST` | `/api/models` | Owner | Read or create project data models. |
| `POST` | `/api/models/rls` | Owner | Update row-level security settings for an authorized model. |
| `GET`, `POST` | `/api/assets` | Owner | Read or create project assets. |

The project code is the source of truth for request/response fields. There is no generated OpenAPI document in this revision. Use `npm run check` and `npm run regression` after route changes.

## Error and operational behavior

Protected routes return `401` without a valid owner session. Invalid/unauthorized project references are rejected by server-side ownership checks and database row-level security. Rate-limited operations return `429` with retry timing. Responses carry `X-Request-ID`; use it to correlate supported activity/error telemetry. `/api/health` can remain healthy while `/api/ready` reports unavailable dependencies.

## AI data boundary

The server persists user and assistant messages under the project conversation. `FELTUS_AI_PROVIDER` selects `ollama`, `openai_compatible`, `vllm`, or `llama_cpp`; endpoint credentials remain server-side. `FELTUS_AI_ENDPOINT_TRUST` selects `local_private`, `private_managed`, `external_trusted`, or `external_unverified`; the server validates private resolutions and requires exact host allowlists for private non-loopback and trusted external endpoints. AI redirects are not followed. The current prompt is sent to the configured endpoint. Project context is sent only when `FELTUS_AI_SEND_PROJECT_CONTEXT=true`. History stays disabled unless `FELTUS_AI_SEND_HISTORY=true`, the trust class permits it, and the server reauthorizes the active conversation against the authenticated owner and project. `external_unverified` never receives stored prior turns. History is limited to the recent configured window, maximum 20; browser-supplied history is never authoritative.

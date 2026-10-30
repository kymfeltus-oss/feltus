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
| `GET`, `POST` | `/api/ai/conversation` | Owner | Retrieve or create the authenticated owner's project conversation. |
| `GET`, `DELETE` | `/api/ai/messages` | Owner | Read or clear messages for an authorized project conversation. |
| `GET` | `/api/ai/status` | Owner | Report AI endpoint/model availability. |
| `GET` | `/api/system-health` | Owner | Read application dependency and system status. |
| `GET` | `/api/activity` | Owner | Read project activity events. |
| `POST` | `/api/ai/chat` | Owner, throttled | Send a non-streaming project-grounded AI request. |
| `POST` | `/api/ai/chat/stream` | Owner, throttled | Send a project-grounded AI request as a token stream. |
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

The server persists user and assistant messages under the project conversation. In this revision, it does not add prior stored messages to the model request. The current request and selected project grounding are sent to the configured AI endpoint. Configure `FELTUS_AI_BASE_URL` only for an endpoint approved to receive those inputs.

# FELTUS CODE integration

FELTUS CODE is served from the core application at `/api/code/ui` and its same-origin assets. It does not introduce another authentication provider, API gateway, AI runtime, or deployment stack. The primary FELTUS `CODE` navigation opens the project workspace in a same-origin frame.

## Project isolation and storage

Each repository root is computed on the server as `FELTUS_CODE_WORKSPACE_ROOT/<authorized FELTUS application UUID>`. Browser requests carry an application ID, but never a filesystem path. The server resolves the application using the current authenticated FELTUS access token and Postgres RLS; file, Git, AI, and task writes also require project write access. FELTUS CODE refuses symlinks and rejects parent-repository inheritance: Git operations require a direct `.git` entry and an exact `git rev-parse --show-toplevel` match. It also strips ambient `GIT_*` overrides and disables system/global Git config so a host-level Git setting cannot redirect repository operations or inject hooks into workspace initialization.

In local development, `scripts/dev.js` places workspaces under `.feltus-storage/code-workspaces`. Production Compose mounts the persistent `feltus_code_workspaces` volume at `/data/feltus-code`; the Docker image prepares that path for its non-root `node` user. `scripts/backup.sh` includes this volume's repository data in the private storage archive, and `scripts/restore-storage.sh` restores it into a separate recovery Compose project. Keep this volume in the same backup and restore cycle as the FELTUS database.

## Database records

Apply `supabase/migrations/20261102010000_feltus_code.sql` through the existing migration runner. It adds one active session per project, action/usage records, and explicit Git checkpoint records. All tables enable RLS and use `feltus_can_access_app`; anonymous access is revoked. Authenticated clients can update only the session's `updated_at` and `model` columns.

## AI and tasks

Model choices come from `/api/ai/models`. Plans stream through `/api/code/ai/plan/stream` when the configured FELTUS provider exposes a stream API; cancellation propagates to the provider and task runner. Edit proposals use the selected relative files only, exclude secret-like source, and include source hashes so a stale proposal cannot overwrite newer work. Applying an edit requires an explicit user action. Agent mode requires confirmation, limits edits to selected files, and runs one of the server's actual repository validation tasks; it has no arbitrary shell tool.

AI project-source context is sent only when the existing AI endpoint trust policy allows `FELTUS_AI_SEND_PROJECT_CONTEXT`. That default remains false for production configuration. Conversation history is not appended to FELTUS CODE requests. Keep `FELTUS_AI_SEND_HISTORY=false` until the runtime has been verified as trusted/private.

## Current UI boundary

The first integrated editor is an accessible, line-numbered plain-text editor with tabs, dirty state, optimistic SHA-256 writes, and reviewable proposal output. It has no third-party CDN dependencies. Monaco and language-specific syntax highlighting are not included in this release; the editor surface is isolated in `src/feltus-code/web/index.html` and its stylesheet/script so it can be replaced without changing the server API.

FELTUS CODE initializes a new empty private repository per application. It does not clone a remote repository, push, merge, deploy, or read another workspace. Those actions remain outside this integration.

The standalone scaffold's mock `dev-server.mjs`, nested package manifest, and scaffold migration are retained for local reference but excluded from the production Docker build context. Production CODE UI/API routes use only the core FELTUS server and its configured AI Gateway.

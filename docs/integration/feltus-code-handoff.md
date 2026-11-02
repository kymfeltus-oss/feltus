# FELTUS CODE — Codex Integration Handoff

Work ONLY in the FELTUS core repository.

A ready scaffold exists under `src/feltus-code`.

Do not redesign it. Integrate it into the existing FELTUS architecture with the smallest safe patch.

## Reuse existing FELTUS services

Reuse:
- authentication/session handling
- project/workspace authorization
- AI Gateway/model routing
- Postgres migration conventions
- UI/navigation styling
- system health
- Git/deployment conventions

Do not add:
- OpenAI
- Anthropic
- AWS
- hosted Supabase
- arbitrary shell execution
- a parallel auth system
- a second deployment stack

## Required wiring

Mount/adapt the handlers in `src/feltus-code/server/routes.mjs` to authenticated routes:

- GET `/api/code/tree`
- GET `/api/code/file`
- PUT `/api/code/file`
- GET `/api/code/search`
- GET `/api/code/repo-map`
- GET `/api/code/git/status`
- GET `/api/code/git/diff`
- GET `/api/code/git/log`
- POST `/api/code/git/checkpoint`
- GET `/api/code/tasks`
- POST `/api/code/task`
- POST `/api/code/ai/plan`
- POST `/api/code/ai/edit`

Every request must:
1. require an authenticated FELTUS session;
2. resolve an authorized FELTUS project/workspace;
3. resolve the repository root server-side;
4. never trust a client-provided absolute repo path.

Connect `createCodeAgent()` to the existing provider-neutral FELTUS AI Gateway using an adapter exposing:

`complete({ messages, model, temperature, maxTokens, signal })`

Optionally add streaming later.

Mount/translate `src/feltus-code/web` into the current FELTUS UI and add a **CODE** navigation item.

Apply/adapt:
`src/feltus-code/migrations/20261102_feltus_code.sql`

Add FELTUS-native RLS policies using current project membership conventions.

Persist:
- coding sessions
- actions
- checkpoints

Keep terminal execution allowlisted. Extend the allowlist only for commands already used by FELTUS.

Do not silently push Git changes.
Do not silently deploy.
Do not expose secrets in responses.

## Required tests

Verify:
- anonymous access blocked
- cross-project access blocked
- path traversal blocked
- symlink traversal blocked
- allowed file read/write works
- arbitrary command execution unavailable
- allowlisted tasks work
- AI adapter receives relevant context
- secret values are not returned
- existing FELTUS regression checks still pass

Return:
1. files changed
2. routes added
3. migration status
4. AI Gateway wiring
5. UI/navigation wiring
6. security tests
7. build/test results
8. true blockers

Final line:
`FELTUS CODE INTEGRATION: PASS`
or
`FELTUS CODE INTEGRATION: BLOCKED — <specific reason>`

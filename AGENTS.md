# FELTUS Repository Instructions

## Repository

FELTUS is an application lifecycle platform. Reuse existing FELTUS architecture, state contracts, lifecycle systems, and established modules before creating new abstractions. Do not duplicate an existing subsystem.

## Safety

- Never touch Production.
- Never touch shared Staging unless the active task explicitly authorizes it.
- Never call provider or deployment APIs unless the active task explicitly authorizes them.
- Never expose, print, copy, or request secret values.
- Preserve the dirty worktree.
- Never reset, clean, stash, discard, or overwrite unrelated worktree changes.
- Never stage or commit unrelated files.
- Never weaken authorization, RLS, repository classification, protected-contract enforcement, validation, or lifecycle safety to make a test pass.
- Migrations and RLS changes require explicit authorization.
- Stale state must never silently remain authoritative.
- Generated source must remain portable and usable outside FELTUS.
- Do not silently overwrite external developer changes.

## Phase Discipline

- Preparation does not authorize implementation.
- A phase marked `PREPARED` is not implemented.
- A phase marked `PARTIAL` is not `VERIFIED`.
- Simulations, documentation, and mocks are not proof of a live capability.
- Run applicable acceptance and regression tests before verification.
- If a required test is blocked, report it as `BLOCKED`.
- Do not begin the next phase without explicit authorization.

## Reporting

Report only **Files Changed**, **Tests & Results**, **Blockers / Gaps**, and **Final Phase Status** unless a failure requires diagnostics.
